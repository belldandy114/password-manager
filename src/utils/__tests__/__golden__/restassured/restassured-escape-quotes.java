package api;

import io.restassured.RestAssured;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.emptyOrNullString;
import static org.hamcrest.Matchers.not;

/**
 * EscapeQuotesTest：由「测试中台」从接口文档生成的 RestAssured 骨架。
 *
 * <p>占位符（形如 {{token}} / {{petId}}）需要替换成真实值，或用系统属性覆盖 baseUrl：
 * <pre>mvn test -DbaseUrl=http://127.0.0.1:8080</pre>
 */
public class EscapeQuotesTest {

    private static String baseUrl;

    @BeforeAll
    public static void setUp() {
        baseUrl = System.getProperty("baseUrl", "https://escape.example.com");
        RestAssured.baseURI = baseUrl;
    }

    /** POST /api/quote（分组：escape） */
    @Test
    public void testSendQuotedPayload() {
        String body = "{\"text\":\"他说：\\\"引号\\\" 与反斜杠 \\\\ 都要转义\",\"multiline\":true}";

        given()
            .header("X-Note", "he said \"hi\"")
            .header("X-Path", "C:\\temp\\logs")
            .header("Content-Type", "application/json")
            .body(body)
        .when()
            .post(baseUrl + "/api/quote")
        .then()
            .statusCode(200)
            .body(not(emptyOrNullString()));
    }
}
