package org.capire.benchmark;

import java.io.IOException;
import java.lang.management.ManagementFactory;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Profile;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import com.sap.cds.reflect.CdsDefinition;
import com.sap.cds.services.runtime.CdsRuntime;

@RestController
@Profile("with-mtx")
@RequestMapping("/__benchmark")
public class BenchmarkControl {
    @Autowired CdsRuntime runtime;

    private final com.sun.management.OperatingSystemMXBean os =
        ManagementFactory.getOperatingSystemMXBean() instanceof com.sun.management.OperatingSystemMXBean bean ? bean : null;
    private final java.util.concurrent.ScheduledExecutorService sampler = Executors.newSingleThreadScheduledExecutor(task -> {
        Thread thread = new Thread(task, "benchmark-heap-sampler");
        thread.setDaemon(true);
        return thread;
    });
    private ScheduledFuture<?> sampling;
    private long started, cpuStarted, gcStarted, gcTimeStarted;
    private double heapPeak;

    private void authorize() {
        var user = runtime.getProvidedUserInfo();
        if (!user.isAuthenticated() || !"benchmark-java".equals(user.getTenant())) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Benchmark tenant authentication required");
        }
    }

    private static String version(String group, String artifact) {
        try (var stream = BenchmarkControl.class.getResourceAsStream("/META-INF/maven/" + group + "/" + artifact + "/pom.properties")) {
            if (stream == null) return "unknown";
            Properties properties = new Properties();
            properties.load(stream);
            return properties.getProperty("version");
        } catch (IOException error) { throw new IllegalStateException(error); }
    }

    private static void annotations(CdsDefinition definition, List<Map<String, Object>> output) {
        List<Map<String, Object>> handlers = definition.getAnnotationValue("extension.code", List.of());
        for (var handler : handlers) {
            output.add(Map.of("name", definition.getQualifiedName(), "phase", handler.get("phase"), "event", handler.get("event")));
        }
    }

    private static String frameworkVersion() {
        try {
            var resources = new PathMatchingResourcePatternResolver().getResources("classpath*:framework/v1/framework-*.wasm");
            return resources.length == 1 ? resources[0].getFilename().replace("framework-", "").replace(".wasm", "") : "unknown";
        } catch (IOException error) { throw new IllegalStateException(error); }
    }

    @GetMapping("/status")
    public Map<String, Object> status() {
        authorize();
        return runtime.requestContext().providedUser().run(context -> {
            var model = context.getModel();
            List<Map<String, Object>> annotations = new ArrayList<>();
            model.entities().forEach(entity -> annotations(entity, annotations));
            model.actions().forEach(action -> annotations(action, annotations));
            var properties = runtime.getEnvironment().getCdsProperties().getCodeExtensions();
            var limits = properties.getLimits();
            Map<String, Object> state = new LinkedHashMap<>();
            state.put("tenant", context.getUserInfo().getTenant());
            state.put("hostRuntime", "java");
            state.put("plugins", properties.isEnabled() ? List.of("com.sap.cds:cds-feature-code-extensions") : List.of());
            state.put("engine", properties.isEnabled() ? "oyster" : null);
            state.put("annotations", annotations);
            state.put("limits", Map.of("maxTime", limits.getMaxExecutionTime().toMillis(), "maxMemory", limits.getMaxAllocatedMemory(),
                "maxDepth", limits.getMaxCallStackDepth(), "maxCallbackCalls", limits.getMaxCallbackCalls()));
            state.put("versions", Map.of("java", System.getProperty("java.version"), "capJava", version("com.sap.cds", "cds-services-api"),
                "codeExtensions", version("com.sap.cds", "cds-feature-code-extensions"), "oysterRuntime", version("com.sap.oyster", "runtime"),
                "oysterFramework", frameworkVersion(), "sqlite", version("org.xerial", "sqlite-jdbc")));
            return state;
        });
    }

    private long gcCount() { return ManagementFactory.getGarbageCollectorMXBeans().stream().mapToLong(bean -> Math.max(0, bean.getCollectionCount())).sum(); }
    private long gcTime() { return ManagementFactory.getGarbageCollectorMXBeans().stream().mapToLong(bean -> Math.max(0, bean.getCollectionTime())).sum(); }
    private synchronized void sampleHeap() { heapPeak = Math.max(heapPeak, ManagementFactory.getMemoryMXBean().getHeapMemoryUsage().getUsed() / 1048576.0); }

    @PostMapping("/metrics/start")
    public synchronized Map<String, Boolean> start() {
        authorize();
        if (sampling != null) throw new ResponseStatusException(HttpStatus.CONFLICT, "Measurement already active");
        started = System.nanoTime();
        cpuStarted = os == null ? 0 : os.getProcessCpuTime();
        gcStarted = gcCount();
        gcTimeStarted = gcTime();
        heapPeak = 0;
        sampleHeap();
        sampling = sampler.scheduleAtFixedRate(this::sampleHeap, 200, 200, TimeUnit.MILLISECONDS);
        return Map.of("ok", true);
    }

    @PostMapping("/metrics/stop")
    public synchronized Map<String, Object> stop() {
        authorize();
        if (sampling == null) throw new ResponseStatusException(HttpStatus.CONFLICT, "No active measurement");
        sampling.cancel(false);
        sampling = null;
        sampleHeap();
        Map<String, Object> resources = new LinkedHashMap<>();
        resources.put("cpuPercent", os == null ? null : 100.0 * (os.getProcessCpuTime() - cpuStarted) / (System.nanoTime() - started));
        resources.put("heapPeakMiB", heapPeak);
        resources.put("rssPeakMiB", null);
        resources.put("eventLoopP99Ms", null);
        resources.put("gcCount", gcCount() - gcStarted);
        resources.put("gcMs", gcTime() - gcTimeStarted);
        return resources;
    }

    @PreDestroy public void close() { sampler.shutdownNow(); }
}
