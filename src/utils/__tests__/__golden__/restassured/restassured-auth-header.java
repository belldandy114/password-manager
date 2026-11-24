package api;

import io.restassured.RestAssured;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.emptyOrNullString;
import static org.hamcrest.Matchers.not;

/**
 * UserApiTest：由「测试中台」从接口文档生成的 RestAssured 骨架。
 *
 * <p>占位符（形如 {{token}} / {{petId}}）需要替换成真实值，或用系统属性覆盖 baseUrl：
 * <pre>mvn test -DbaseUrl=http://127.0.0.1:8080</pre>
 */
public class UserApiTest {

    private static String baseUrl;

    @BeforeAll
    public static void setUp() {
        baseUrl = System.getProperty("baseUrl", "https://users.example.com");
        RestAssured.baseURI = baseUrl;
    }

    /** GET /users/1（分组：users） */
    @Test
    public void testGetUser() {
        given()
            .header("Authorization", "Bearer {{token}}")
            .header("Accept", "application/json")
        .when()
            .get(baseUrl + "/users/1")
        .then()
            .statusCode(200)
            .body(not(emptyOrNullString()));
    }

    /** DELETE /users/1（分组：users） */
    @Test
    public void testGetUser2() {
        given()
            .header("Authorization", "Bearer {{token}}")
        .when()
            .delete(baseUrl + "/users/1")
        .then()
            .statusCode(200)
            .body(not(emptyOrNullString()));
    }
}
