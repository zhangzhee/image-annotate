import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0x0000;
const TAG: string = 'ImageAnnotate';

@Entry
@Component
struct Index {
  controller: webview.WebviewController = new webview.WebviewController();

  aboutToAppear(): void {
    // 初始化 Web 引擎，允许加载 rawfile 中的本地网页资源
    webview.WebviewController.initializeWebEngine();
  }

  build() {
    Column() {
      Web({ src: $rawfile('index.html'), controller: this.controller })
        .width('100%')
        .height('100%')
        .domStorageAccess(true)
        .fileAccess(true)
        .javaScriptAccess(true)
        .onConsole((event) => {
          hilog.info(DOMAIN, TAG, 'web console: %{public}s', event.message);
        })
    }
    .width('100%')
    .height('100%')
  }
}
