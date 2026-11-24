package model;

import java.util.List;

@Data
public class ApiResponse {
    private Long code;
    private String message;
    private ApiResponseData data;

    @Data
    public static class ApiResponseData {
        private Long total;
        private List<ApiResponseDataItems> items;

        @Data
        public static class ApiResponseDataItems {
            private Long id;
            private String name;
            private List<String> tags;
            private ApiResponseDataItemsOwner owner;

            @Data
            public static class ApiResponseDataItemsOwner {
                private Long uid;
                private String email;
            }
        }
    }
}
