package expo.modules.widgetrefresher

import android.content.Context
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class WidgetRefresherModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("WidgetRefresher")

    Function("start") { intervalSec: Int ->
      WidgetRefreshService.start(context, intervalSec.coerceIn(5, 3600))
    }

    Function("stop") {
      WidgetRefreshService.stop(context)
    }

    Function("isEnabled") {
      WidgetRefreshService.isEnabled(context)
    }

    Function("getIntervalSec") {
      WidgetRefreshService.intervalSec(context)
    }
  }
}
