package org.capire.benchmark;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import cds.gen.benchmarkextensionservice.*;
import com.sap.cds.services.handler.EventHandler;
import com.sap.cds.services.handler.annotations.On;
import com.sap.cds.services.handler.annotations.ServiceName;

@Component
@ServiceName(BenchmarkExtensionService_.CDS_NAME)
public class ExtensionHandler implements EventHandler {
    @Autowired BenchmarkExtensionService extension;

    @On public void empty(NativeEmptyContext c) { c.setResult(c.getSeed()); }
    @On public void calculation(NativeCalculationContext c) { c.setResult(Workload.cpu(c.getSeed(), c.getIterations())); }
    @On public void read(NativeCqlReadContext c) { c.setResult(Workload.execute(c.getSeed(), c.getIterations(), c.getCalls(), c.getLookupID(), c.getEffectID(), extension, BenchmarkExtensionService_.CDS_NAME, false)); }
    @On public void write(NativeCqlWriteContext c) { c.setResult(Workload.execute(c.getSeed(), c.getIterations(), c.getCalls(), c.getLookupID(), c.getEffectID(), extension, BenchmarkExtensionService_.CDS_NAME, true)); }
    @On public void validation(NativeValidationContext c) { c.setResult(Workload.validate(c.getQuantity(), c.getUnitPrice(), c.getLookupID(), extension, BenchmarkExtensionService_.CDS_NAME, false)); }
    @On public void validationRead(NativeValidationReadContext c) { c.setResult(Workload.validate(c.getQuantity(), c.getUnitPrice(), c.getLookupID(), extension, BenchmarkExtensionService_.CDS_NAME, true)); }
    @On public void unimplemented(UnimplementedContext c) { c.setResult(null); }
}
