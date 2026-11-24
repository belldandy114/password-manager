package pages;

import com.microsoft.playwright.Locator;
import com.microsoft.playwright.Page;

/**
 * EscapePage：转义样例页 的 Page Object（由「测试中台」从元素库生成）。
 *
 * <p>用法：
 * <pre>
 * EscapePage page = new EscapePage(playwrightPage);
 * page.open();
 * page.pathHint().click();
 * </pre>
 */
public class EscapePage {

    private final Page page;

    public EscapePage(Page page) {
        this.page = page;
    }

    /** 打开页面（baseUrl 由生成时填写，改地址只改这一处） */
    public void open() {
        page.navigate("https://escape.example.com/");
    }

    /** 元素：PathHint（text=C:\temp\logs "raw"） */
    public Locator pathHint() {
        return page.getByText("C:\\temp\\logs \"raw\"");
    }

    /** 元素：PathHint（css=#dup） */
    public Locator pathHint2() {
        return page.locator("#dup");
    }
}
