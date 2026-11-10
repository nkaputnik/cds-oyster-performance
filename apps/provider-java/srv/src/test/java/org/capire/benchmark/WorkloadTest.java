package org.capire.benchmark;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

class WorkloadTest {
    // Expected values come from the existing JavaScript benchmark reference.
    @ParameterizedTest
    @CsvSource({
        "0, 0, 0", "7, 100, 2013694255", "-1, 100, 558999335",
        "2147483647, 1000, 563739695", "2147483647, 10000, 1689061471",
        "17, 50000, 1148372977"
    })
    void matchesJavaScriptChecksums(int seed, int iterations, int expected) {
        assertEquals(expected, Workload.cpu(seed, iterations));
    }
}
