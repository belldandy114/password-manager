package pages.petstore;

import com.microsoft.playwright.Locator;
import com.microsoft.playwright.Page;
import com.microsoft.playwright.options.AriaRole;

/**
 * LoginPage：登录页 的 Page Object（由「测试中台」从元素库生成）。
 *
 * <p>用法：
 * <pre>
 * LoginPage page = new LoginPage(playwrightPage);
 * page.open();
 * page.username().click();
 * </pre>
 */
public class LoginPage {

    private final Page page;

    public LoginPage(Page page) {
        this.page = page;
    }

    /** 打开页面（baseUrl 由生成时填写，改地址只改这一处） */
    public void open() {
        page.navigate("https://petstore.example.com/login");
    }

    /** 元素：Username（css=#user） */
    public Locator username() {
        return page.locator("#user");
    }

    /** 元素：密码（css=input[name=password]） */
    public Locator password() {
        return page.locator("input[name=password]");
    }

    /** 元素：登录按钮（role=button） */
    public Locator loginButton() {
        return page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("登录"));
    }

    /** 元素：忘记密码链接（text=忘记密码？） */
    public Locator forgotPassword() {
        return page.getByText("忘记密码？");
    }
}
