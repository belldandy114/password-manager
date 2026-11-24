package model;

@Data
public class UserProfile {
    private Long id;
    private Object meta;
    private UserProfileProfile profile;

    @Data
    public static class UserProfileProfile {
        private Object nickname;
        private Object avatar;
    }
}
