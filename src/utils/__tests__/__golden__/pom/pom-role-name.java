package pages;

import com.microsoft.playwright.Locator;
import com.microsoft.playwright.Page;
import com.microsoft.playwright.options.AriaRole;

/**
 * RoleNamePage：角色样例页 的 Page Object（由「测试中台」从元素库生成）。
 *
 * <p>用法：
 * <pre>
 * RoleNamePage page = new RoleNamePage(playwrightPage);
 * page.open();
 * page.loginButton().click();
 * </pre>
 */
public class RoleNamePage {

    private final Page page;

    public RoleNamePage(Page page) {
        this.page = page;
    }

    /** 打开页面（baseUrl 由生成时填写，改地址只改这一处） */
    public void open() {
        page.navigate("https://role.example.com/login");
    }

    /** 元素：登录按钮（role=button） */
    public Locator loginButton() {
        return page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("登录"));
    }
}
