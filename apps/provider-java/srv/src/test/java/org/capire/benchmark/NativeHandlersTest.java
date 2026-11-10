package org.capire.benchmark;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import cds.gen.benchmarkservice.BenchmarkService;
import com.sap.cds.services.ServiceException;

@SpringBootTest
class NativeHandlersTest {
    @Autowired BenchmarkService benchmark;

    @Test
    void executesNativeActionsThroughCap() {
        benchmark.noop();
        benchmark.nativeNoop();
        assertEquals(1, benchmark.probe());
        assertEquals(2013694255, benchmark.nativeCalculation(7, 100, 0, null, null));
        assertEquals(2013694255, benchmark.nativeCalculationExtension(7, 100, 0, null, null));
        assertEquals(7, benchmark.nativeEmptyExtension(7, 100, 0, null, null));
        assertEquals(7, benchmark.extensionBypass(7, 100, 0, null, null));
        assertEquals(7, benchmark.extensionUnimplemented(7, 100, 0, null, null));
    }

    @Test
    void validatesAcceptedAndRejectedAmounts() {
        assertEquals(20, benchmark.nativeValidation(2, 10, null));
        assertEquals(20, benchmark.nativeValidationExtension(2, 10, null));
        assertThrows(ServiceException.class, () -> benchmark.nativeValidation(2, 600, null));
        assertThrows(ServiceException.class, () -> benchmark.nativeValidationExtension(0, 10, null));
    }
}
