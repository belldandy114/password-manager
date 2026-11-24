package api.petstore;

import org.junit.jupiter.api.Test;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.emptyOrNullString;
import static org.hamcrest.Matchers.not;

/**
 * PetStoreApiTest：由「测试中台」从接口文档生成的 RestAssured 骨架。
 *
 * <p>占位符（形如 {{token}} / {{petId}}）需要替换成真实值，或用系统属性覆盖 baseUrl：
 * <pre>mvn test -DbaseUrl=http://127.0.0.1:8080</pre>
 */
public class PetStoreApiTest extends BaseTest {

    /** GET /pets?limit=20（分组：pets） */
    @Test
    public void testListPets() {
        given()
            .header("X-Tenant", "demo")
            .header("Authorization", "Bearer {{token}}")
        .when()
            .get(baseUrl + "/pets?limit=20")
        .then()
            .statusCode(200)
            .body(not(emptyOrNullString()));
    }

    /** POST /pets（分组：pets） */
    @Test
    public void testCreatePet() {
        String body = "{\n  \"id\": 1,\n  \"name\": \"string\",\n  \"tags\": [\n    \"string\"\n  ],\n  \"status\": \"available\",\n  \"createdAt\": \"2024-01-01T00:00:00Z\"\n}";

        given()
            .header("X-Tenant", "demo")
            .header("Authorization", "Bearer {{token}}")
            .header("Content-Type", "application/json")
            .body(body)
        .when()
            .post(baseUrl + "/pets")
        .then()
            .statusCode(200)
            .body(not(emptyOrNullString()));
    }

    /** GET /pets/{{petId}}?verbose={{verbose}}（分组：pets） */
    @Test
    public void testGetPet() {
        given()
            .header("Authorization", "Bearer {{token}}")
        .when()
            .get(baseUrl + "/pets/{{petId}}?verbose={{verbose}}")
        .then()
            .statusCode(200)
            .body(not(emptyOrNullString()));
    }

    /** DELETE /pets/{{petId}}（分组：pets） */
    @Test
    public void testDeletePet() {
        given()
        .when()
            .delete(baseUrl + "/pets/{{petId}}")
        .then()
            .statusCode(200)
            .body(not(emptyOrNullString()));
    }
}
