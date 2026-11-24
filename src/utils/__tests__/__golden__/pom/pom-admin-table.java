package pages;

import com.microsoft.playwright.Locator;
import com.microsoft.playwright.Page;
import com.microsoft.playwright.options.AriaRole;

/**
 * AdminTablePage：用户管理列表页 的 Page Object（由「测试中台」从元素库生成）。
 *
 * <p>用法：
 * <pre>
 * AdminTablePage page = new AdminTablePage(playwrightPage);
 * page.open();
 * page.rows().click();
 * </pre>
 */
public class AdminTablePage {

    private final Page page;

    public AdminTablePage(Page page) {
        this.page = page;
    }

    /** 打开页面（baseUrl 由生成时填写，改地址只改这一处） */
    public void open() {
        page.navigate("https://admin.example.com/users");
    }

    /** 元素：Rows（xpath=//table/tbody/tr） */
    public Locator rows() {
        return page.locator("xpath=//table/tbody/tr");
    }

    /** 元素：SearchBox（css=#search） */
    public Locator searchBox() {
        return page.locator("#search");
    }

    /** 元素：详情链接（role=link） */
    public Locator detailLink() {
        return page.getByRole(AriaRole.LINK, new Page.GetByRoleOptions().setName("查看详情"));
    }
}
