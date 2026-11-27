package pages;

import com.microsoft.playwright.Locator;
import com.microsoft.playwright.Page;

/**
 * TestIdPage：testid 样例页 的 Page Object（由「测试中台」从元素库生成）。
 *
 * <p>用法：
 * <pre>
 * TestIdPage page = new TestIdPage(playwrightPage);
 * page.open();
 * page.submitBtn().click();
 * </pre>
 */
public class TestIdPage {

    private final Page page;

    public TestIdPage(Page page) {
        this.page = page;
    }

    /** 打开页面（baseUrl 由生成时填写，改地址只改这一处） */
    public void open() {
        page.navigate("https://testid.example.com/form");
    }

    /** 元素：提交按钮（testid=submit） */
    public Locator submitBtn() {
        return page.getByTestId("submit");
    }
}
