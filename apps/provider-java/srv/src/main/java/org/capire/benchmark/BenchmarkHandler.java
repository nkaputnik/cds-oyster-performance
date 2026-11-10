package org.capire.benchmark;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import cds.gen.benchmarkservice.*;
import cds.gen.benchmarkextensionservice.BenchmarkExtensionService;
import com.sap.cds.CdsData;
import com.sap.cds.ql.Insert;
import com.sap.cds.ql.Select;
import com.sap.cds.ql.Update;
import com.sap.cds.ql.cqn.CqnAnalyzer;
import com.sap.cds.services.ErrorStatuses;
import com.sap.cds.services.EventContext;
import com.sap.cds.services.ServiceException;
import com.sap.cds.services.cds.CdsUpdateEventContext;
import com.sap.cds.services.cds.CqnService;
import com.sap.cds.services.handler.EventHandler;
import com.sap.cds.services.handler.annotations.After;
import com.sap.cds.services.handler.annotations.Before;
import com.sap.cds.services.handler.annotations.On;
import com.sap.cds.services.handler.annotations.ServiceName;
import com.sap.cds.services.persistence.PersistenceService;

@Component
@ServiceName(BenchmarkService_.CDS_NAME)
public class BenchmarkHandler implements EventHandler {
    @Autowired BenchmarkService benchmark;
    @Autowired BenchmarkExtensionService extension;
    @Autowired PersistenceService db;

    @On public void noop(NoopContext context) { context.setCompleted(); }
    @On public void nativeNoop(NativeNoopContext context) { context.setCompleted(); }
    @On public void probe(ProbeContext context) { context.setResult(1); }
    @On public void calculation(NativeCalculationContext c) { c.setResult(Workload.cpu(c.getSeed(), c.getIterations())); }
    @On public void read(NativeCqlReadContext c) { c.setResult(Workload.execute(c.getSeed(), c.getIterations(), c.getCalls(), c.getLookupID(), c.getEffectID(), benchmark, BenchmarkService_.CDS_NAME, false)); }
    @On public void write(NativeCqlWriteContext c) { c.setResult(Workload.execute(c.getSeed(), c.getIterations(), c.getCalls(), c.getLookupID(), c.getEffectID(), benchmark, BenchmarkService_.CDS_NAME, true)); }
    @On public void directRead(NativeDirectReadContext c) { c.setResult(Workload.execute(c.getSeed(), c.getIterations(), c.getCalls(), c.getLookupID(), c.getEffectID(), db, "perf", false)); }
    @On public void directWrite(NativeDirectWriteContext c) { c.setResult(Workload.execute(c.getSeed(), c.getIterations(), c.getCalls(), c.getLookupID(), c.getEffectID(), db, "perf", true)); }
    @On public void validation(NativeValidationContext c) { c.setResult(Workload.validate(c.getQuantity(), c.getUnitPrice(), c.getLookupID(), benchmark, BenchmarkService_.CDS_NAME, false)); }
    @On public void validationRead(NativeValidationReadContext c) { c.setResult(Workload.validate(c.getQuantity(), c.getUnitPrice(), c.getLookupID(), benchmark, BenchmarkService_.CDS_NAME, true)); }

    @Before(event = {CqnService.EVENT_CREATE, CqnService.EVENT_UPDATE}, entity = NativeEmptyWriteRows_.CDS_NAME)
    public void emptyWrite() {}

    @Before(event = {CqnService.EVENT_CREATE, CqnService.EVENT_UPDATE}, entity = NativeCalculationWriteRows_.CDS_NAME)
    public void calculateWrite(List<CdsData> rows) {
        for (var row : rows) row.put("value", Workload.cpu(Workload.number(row, "value", 7), 100));
    }

    @Before(event = {CqnService.EVENT_CREATE, CqnService.EVENT_UPDATE}, entity = {NativeCqlReadWriteRows_.CDS_NAME, NativeCqlWriteWriteRows_.CDS_NAME})
    public void ioWrite(EventContext context, List<CdsData> rows) {
        boolean write = context.getTarget().getQualifiedName().equals(NativeCqlWriteWriteRows_.CDS_NAME);
        for (var row : rows) {
            var input = new HashMap<>(row);
            input.put("seed", Workload.number(row, "seed", Workload.number(row, "value", 7)));
            input.put("iterations", 0);
            input.putIfAbsent("calls", 1);
            row.put("value", Workload.execute(input, benchmark, BenchmarkService_.CDS_NAME, write));
        }
    }

    @Before(event = {CqnService.EVENT_CREATE, CqnService.EVENT_UPDATE}, entity = {NativeValidationWriteRows_.CDS_NAME, NativeValidationReadWriteRows_.CDS_NAME})
    public void validateWrite(EventContext context, List<CdsData> rows) {
        boolean update = context.getEvent().equals(CqnService.EVENT_UPDATE);
        boolean read = context.getTarget().getQualifiedName().equals(NativeValidationReadWriteRows_.CDS_NAME);
        for (var row : rows) {
            Map<String, Object> input = row;
            if (update && row.get("ID") == null) {
                input = new HashMap<>(row);
                input.putAll(CqnAnalyzer.create(context.getModel())
                    .analyze(context.as(CdsUpdateEventContext.class).getCqn()).targetKeys());
            }
            Workload.validate(input, benchmark, BenchmarkService_.CDS_NAME, update, read);
        }
    }

    @After(event = CqnService.EVENT_READ, entity = {NativeEmptySmallRows_.CDS_NAME, NativeEmptyLargeRows_.CDS_NAME})
    public void emptyRead() {}

    @After(event = CqnService.EVENT_READ, entity = {NativeCalculationSmallRows_.CDS_NAME, NativeCalculationLargeRows_.CDS_NAME})
    public void calculateRead(List<CdsData> rows) {
        for (var row : rows) row.put("checksum", Workload.cpu(((Number) row.get("value")).intValue(), 100));
    }

    @After(event = CqnService.EVENT_READ, entity = {NativeCqlReadSmallRows_.CDS_NAME, NativeCqlReadLargeRows_.CDS_NAME, NativeCqlWriteSmallRows_.CDS_NAME, NativeCqlWriteLargeRows_.CDS_NAME})
    public void ioRead(EventContext context, List<CdsData> rows) {
        boolean write = context.getTarget().getQualifiedName().startsWith("BenchmarkService.NativeCqlWrite");
        int extra = Workload.execute(0, 0, 1, null, null, benchmark, BenchmarkService_.CDS_NAME, write);
        for (var row : rows) row.put("checksum", (((Number) row.get("value")).intValue() + extra) & Integer.MAX_VALUE);
    }

    @On public void lookupIndividual(NativeLookupIndividualContext c) {
        int value = Workload.cpu(c.getSeed(), c.getIterations());
        for (var id : c.getLookupIDs()) {
            var row = benchmark.run(Select.from(LookupRows_.class).columns("ID", "value")
                .where(r -> r.ID().eq(id))).first().orElseThrow(() ->
                    new ServiceException(ErrorStatuses.BAD_REQUEST, "Lookup row missing"));
            value = (value + row.getValue()) & Integer.MAX_VALUE;
        }
        c.setResult(value);
    }

    @On public void lookupBatch(NativeLookupBatchContext c) {
        var rows = benchmark.run(Select.from(LookupRows_.class).columns("ID", "value")
            .where(r -> r.ID().in(c.getLookupIDs())).orderBy("ID")).list();
        if (rows.size() != c.getLookupIDs().size()) throw new ServiceException(ErrorStatuses.BAD_REQUEST, "Lookup row missing");
        int value = Workload.cpu(c.getSeed(), c.getIterations());
        for (var row : rows) value = (value + row.getValue()) & Integer.MAX_VALUE;
        c.setResult(value);
    }

    @On public void nativeEmptyExtension(NativeEmptyExtensionContext c) { c.setResult(extension.nativeEmpty(c.getSeed(), c.getIterations(), c.getCalls(), c.getLookupID(), c.getEffectID())); }
    @On public void nativeCalculationExtension(NativeCalculationExtensionContext c) { c.setResult(extension.nativeCalculation(c.getSeed(), c.getIterations(), c.getCalls(), c.getLookupID(), c.getEffectID())); }
    @On public void nativeReadExtension(NativeCqlReadExtensionContext c) { c.setResult(extension.nativeCqlRead(c.getSeed(), c.getIterations(), c.getCalls(), c.getLookupID(), c.getEffectID())); }
    @On public void nativeWriteExtension(NativeCqlWriteExtensionContext c) { c.setResult(extension.nativeCqlWrite(c.getSeed(), c.getIterations(), c.getCalls(), c.getLookupID(), c.getEffectID())); }
    @On public void nativeValidationExtension(NativeValidationExtensionContext c) { c.setResult(extension.nativeValidation(c.getQuantity(), c.getUnitPrice(), c.getLookupID())); }
    @On public void nativeValidationReadExtension(NativeValidationReadExtensionContext c) { c.setResult(extension.nativeValidationRead(c.getQuantity(), c.getUnitPrice(), c.getLookupID())); }
    @On public void oysterEmptyExtension(OysterEmptyExtensionContext c) { c.setResult(extension.oysterEmpty(c.getSeed(), c.getIterations(), c.getCalls(), c.getLookupID(), c.getEffectID())); }
    @On public void oysterCalculationExtension(OysterCalculationExtensionContext c) { c.setResult(extension.oysterCalculation(c.getSeed(), c.getIterations(), c.getCalls(), c.getLookupID(), c.getEffectID())); }
    @On public void oysterReadExtension(OysterCqlReadExtensionContext c) { c.setResult(extension.oysterCqlRead(c.getSeed(), c.getIterations(), c.getCalls(), c.getLookupID(), c.getEffectID())); }
    @On public void oysterWriteExtension(OysterCqlWriteExtensionContext c) { c.setResult(extension.oysterCqlWrite(c.getSeed(), c.getIterations(), c.getCalls(), c.getLookupID(), c.getEffectID())); }
    @On public void oysterValidationExtension(OysterValidationExtensionContext c) { c.setResult(extension.oysterValidation(c.getQuantity(), c.getUnitPrice(), c.getLookupID())); }
    @On public void oysterValidationReadExtension(OysterValidationReadExtensionContext c) { c.setResult(extension.oysterValidationRead(c.getQuantity(), c.getUnitPrice(), c.getLookupID())); }
    @On public void bypass(ExtensionBypassContext c) { c.setResult(c.getSeed()); }
    @On public void unimplemented(ExtensionUnimplementedContext c) {
        Integer value = extension.unimplemented(c.getSeed(), c.getIterations(), c.getCalls(), c.getLookupID(), c.getEffectID());
        c.setResult(value == null ? c.getSeed() : value);
    }

    @On public void scan(NativeScanContext c) {
        int cursor = c.getCursor(), left = c.getCount(), checksum = 0;
        while (left > 0) {
            int after = cursor;
            var rows = benchmark.run(Select.from(NoHandlerLargeRows_.class).columns("ID", "value")
                .where(r -> r.ID().gt(after)).orderBy("ID").limit(Math.min(c.getPageSize(), left))).list();
            if (rows.isEmpty()) throw new ServiceException(ErrorStatuses.BAD_REQUEST, "Scan requested more rows than exist");
            for (var row : rows) checksum = (checksum + Workload.cpu(row.getValue(), c.getIterations() == null ? 100 : c.getIterations())) & Integer.MAX_VALUE;
            left -= rows.size();
            cursor = rows.getLast().getId();
        }
        c.setResult(checksum);
    }

    @On public void rollback(RollbackProbeContext c) {
        int lookupID = benchmark.run(Select.from(LookupRows_.class).columns("ID").orderBy("ID").limit(1)).single().getId();
        benchmark.run(Insert.into("BenchmarkService." + c.getEntity()).entry(Map.of(
            "ID", c.getId(), "value", 7, "quantity", 2, "unitPrice", 10, "effectID", c.getEffectID(), "lookupID", lookupID)));
        benchmark.run(Update.entity(SideEffectRows_.class).data("value", c.getValue()).where(r -> r.ID().eq(c.getEffectID())));
        throw new ServiceException(ErrorStatuses.CONFLICT, "Deliberate rollback probe");
    }
}
