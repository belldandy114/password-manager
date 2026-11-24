package api;

import io.restassured.RestAssured;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.emptyOrNullString;
import static org.hamcrest.Matchers.not;

/**
 * OrderApiTest：由「测试中台」从接口文档生成的 RestAssured 骨架。
 *
 * <p>占位符（形如 {{token}} / {{petId}}）需要替换成真实值，或用系统属性覆盖 baseUrl：
 * <pre>mvn test -DbaseUrl=http://127.0.0.1:8080</pre>
 */
public class OrderApiTest {

    private static String baseUrl;

    @BeforeAll
    public static void setUp() {
        baseUrl = System.getProperty("baseUrl", "https://api.example.com/shop");
        RestAssured.baseURI = baseUrl;
    }

    /** POST /orders（分组：orders） */
    @Test
    public void testCreateOrder() {
        String body = "{\n  \"id\": \"string\",\n  \"customer\": {\n    \"name\": \"string\",\n    \"orders\": [\n      {}\n    ]\n  }\n}";

        given()
            .header("X-Trace", "trace-1")
            .header("X-API-Key", "{{token}}")
            .header("Content-Type", "application/json")
            .body(body)
        .when()
            .post(baseUrl + "/orders")
        .then()
            .statusCode(200)
            .body(not(emptyOrNullString()));
    }

    /** GET /orders/{{orderId}}?expand={{expand}}（分组：orders） */
    @Test
    public void testGetOrder() {
        given()
            .header("X-API-Key", "{{token}}")
        .when()
            .get(baseUrl + "/orders/{{orderId}}?expand={{expand}}")
        .then()
            .statusCode(200)
            .body(not(emptyOrNullString()));
    }

    /** PUT /orders/{{orderId}}（分组：orders） */
    @Test
    public void testReplaceOrder() {
        String body = "{\n  \"id\": \"string\",\n  \"customer\": {\n    \"name\": \"string\",\n    \"orders\": [\n      {}\n    ]\n  }\n}";

        given()
            .header("X-API-Key", "{{token}}")
            .header("Content-Type", "application/json")
            .body(body)
        .when()
            .put(baseUrl + "/orders/{{orderId}}")
        .then()
            .statusCode(200)
            .body(not(emptyOrNullString()));
    }
}
