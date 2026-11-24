package com.example.model;

import java.math.BigDecimal;
import java.util.List;

@Data
public class RecordList {
    private List<RecordListRecords> records;

    @Data
    public static class RecordListRecords {
        private String code;
        private BigDecimal amount;
        private Boolean flag;
        private String label;
    }
}
