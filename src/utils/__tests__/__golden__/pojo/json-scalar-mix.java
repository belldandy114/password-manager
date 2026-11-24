package model;

import com.fasterxml.jackson.annotation.JsonProperty;

@Data
public class ScalarMix {
    private Boolean ok;
    private Long count;
    private Double ratio;
    private String note;
    private String when;
    private ScalarMixEmpty empty;
    @JsonProperty("odd\"key\\name")
    private Long oddKeyName;

    @Data
    public static class ScalarMixEmpty {
    }
}
