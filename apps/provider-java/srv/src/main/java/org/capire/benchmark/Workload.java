package org.capire.benchmark;

import java.util.HashMap;
import java.util.Map;

import com.sap.cds.ql.Select;
import com.sap.cds.ql.Update;
import com.sap.cds.services.ErrorStatuses;
import com.sap.cds.services.ServiceException;
import com.sap.cds.services.cds.CqnService;

final class Workload {
    private Workload() {}

    static int cpu(int seed, int iterations) {
        int value = seed & Integer.MAX_VALUE;
        for (int i = 0; i < iterations; i++) {
            value = (value * 17 + i * 2 - 1) & Integer.MAX_VALUE;
        }
        return value;
    }

    static int number(Map<String, Object> input, String key, int fallback) {
        Object value = input.get(key);
        return value == null ? fallback : ((Number) value).intValue();
    }

    static int execute(Map<String, Object> input, CqnService service, String namespace, boolean write) {
        return execute(number(input, "seed", 0), number(input, "iterations", 0), number(input, "calls", 0),
            (Integer) input.get("lookupID"), (Integer) input.get("effectID"), service, namespace, write);
    }

    static int execute(Integer seed, Integer iterations, Integer calls, Integer lookupID, Integer effectID,
                       CqnService service, String namespace, boolean write) {
        int value = cpu(seed == null ? 0 : seed, iterations == null ? 0 : iterations);
        for (int i = 0; i < (calls == null ? 0 : calls); i++) {
            if (write) {
                Object id = effectID;
                if (id == null) {
                    id = service.run(Select.from(namespace + ".SideEffectRows").columns("ID")
                        .orderBy("ID").limit(1)).single().get("ID");
                }
                Object targetID = id;
                service.run(Update.entity(namespace + ".SideEffectRows").data("value", value)
                    .where(row -> row.get("ID").eq(targetID)));
            } else {
                var query = Select.from(namespace + ".LookupRows").columns("value").limit(1);
                Object id = lookupID;
                if (id == null) query.orderBy("ID");
                else query.where(row -> row.get("ID").eq(id));
                var row = service.run(query).first().orElseThrow(() ->
                    new ServiceException(ErrorStatuses.BAD_REQUEST, "Lookup row missing"));
                value = (value + ((Number) row.get("value")).intValue()) & Integer.MAX_VALUE;
            }
        }
        return value;
    }

    static int validate(Map<String, Object> input, CqnService service, String namespace,
                        boolean update, boolean readLimit) {
        Map<String, Object> data = input;
        if (update && (data.get("quantity") == null || data.get("unitPrice") == null
                || (readLimit && data.get("lookupID") == null))) {
            Object id = input.get("ID");
            data = new HashMap<>(service.run(Select.from(namespace + ".NoHandlerWriteRows")
                .columns("quantity", "unitPrice", "lookupID").where(row -> row.get("ID").eq(id)))
                .first().orElseThrow(() -> new ServiceException(ErrorStatuses.NOT_FOUND, "Write row missing")));
            data.putAll(input);
        }
        return validate((Integer) data.get("quantity"), (Integer) data.get("unitPrice"),
            (Integer) data.get("lookupID"), service, namespace, readLimit);
    }

    static int validate(Integer requestedQuantity, Integer requestedPrice, Integer lookupID,
                        CqnService service, String namespace, boolean readLimit) {
        int quantity = requestedQuantity == null ? 0 : requestedQuantity;
        int unitPrice = requestedPrice == null ? 0 : requestedPrice;
        if (quantity <= 0 || unitPrice <= 0) {
            throw new ServiceException(ErrorStatuses.BAD_REQUEST, "Quantity and unit price must be positive integers");
        }
        int limit = 1000;
        if (readLimit) {
            Object id = lookupID;
            var row = service.run(Select.from(namespace + ".LookupRows").columns("limit")
                .where(r -> r.get("ID").eq(id))).first().orElseThrow(() ->
                    new ServiceException(ErrorStatuses.BAD_REQUEST, "Limit row missing"));
            limit = ((Number) row.get("limit")).intValue();
        }
        long amount = (long) quantity * unitPrice;
        if (amount > limit) throw new ServiceException(ErrorStatuses.BAD_REQUEST, "Amount exceeds limit");
        return (int) amount;
    }
}
