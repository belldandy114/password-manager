package api.petstore;

import io.restassured.RestAssured;
import org.junit.jupiter.api.BeforeAll;

/**
 * 生成物共用的基类：把 baseUrl 收敛到一处（-DbaseUrl=... 可覆盖）。
 */
public abstract class BaseTest {

    protected static String baseUrl;

    @BeforeAll
    public static void setUp() {
        baseUrl = System.getProperty("baseUrl", "https://petstore.example.com/v1");
        RestAssured.baseURI = baseUrl;
    }
}
