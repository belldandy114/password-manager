package pages;

import com.microsoft.playwright.Locator;
import com.microsoft.playwright.Page;

/**
 * LabelPage：label 样例页 的 Page Object（由「测试中台」从元素库生成）。
 *
 * <p>用法：
 * <pre>
 * LabelPage page = new LabelPage(playwrightPage);
 * page.open();
 * page.usernameLabel().click();
 * </pre>
 */
public class LabelPage {

    private final Page page;

    public LabelPage(Page page) {
        this.page = page;
    }

    /** 打开页面（baseUrl 由生成时填写，改地址只改这一处） */
    public void open() {
        page.navigate("https://label.example.com/form");
    }

    /** 元素：用户名标签（label=用户名） */
    public Locator usernameLabel() {
        return page.getByLabel("用户名");
    }
}
