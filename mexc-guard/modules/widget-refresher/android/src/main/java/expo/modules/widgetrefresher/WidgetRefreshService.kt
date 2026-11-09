package expo.modules.widgetrefresher

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Foreground service that asks the home-screen widget to refresh every N seconds by sending it
 * APPWIDGET_UPDATE. The widget's provider then runs the JS widget task handler (headless), which
 * fetches fresh data from MEXC. Android caps widget self-updates at 30 minutes, hence this service.
 */
class WidgetRefreshService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private var intervalMs = DEFAULT_INTERVAL_SEC * 1000L

  private val tick = object : Runnable {
    override fun run() {
      if (!requestWidgetUpdate()) {
        // No widget on the home screen any more: nothing to keep alive for.
        stop(this@WidgetRefreshService)
        return
      }
      handler.postDelayed(this, intervalMs)
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    intervalMs = prefs(this).getInt(KEY_INTERVAL, DEFAULT_INTERVAL_SEC) * 1000L
    ServiceCompat.startForeground(
      this,
      NOTIFICATION_ID,
      buildNotification(),
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0,
    )
    handler.removeCallbacks(tick)
    handler.post(tick)
    return START_STICKY
  }

  override fun onDestroy() {
    handler.removeCallbacks(tick)
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun requestWidgetUpdate(): Boolean {
    val provider = ComponentName(packageName, "$packageName.widget.Pnl")
    val ids = AppWidgetManager.getInstance(this).getAppWidgetIds(provider)
    if (ids.isEmpty()) return false
    sendBroadcast(
      Intent(AppWidgetManager.ACTION_APPWIDGET_UPDATE)
        .setComponent(provider)
        .putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids),
    )
    return true
  }

  private fun buildNotification(): Notification {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Cập nhật widget", NotificationManager.IMPORTANCE_MIN).apply {
          setShowBadge(false)
        },
      )
    }
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setContentTitle("MEXC Guard")
      .setContentText("Widget PnL tự cập nhật mỗi ${intervalMs / 1000}s")
      .setContentIntent(open)
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .build()
  }

  companion object {
    private const val CHANNEL_ID = "widget_refresh"
    private const val NOTIFICATION_ID = 4201
    private const val PREFS = "widget_refresher"
    private const val KEY_INTERVAL = "interval_sec"
    private const val KEY_ENABLED = "enabled"
    const val DEFAULT_INTERVAL_SEC = 15

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun start(context: Context, intervalSec: Int) {
      prefs(context).edit().putInt(KEY_INTERVAL, intervalSec).putBoolean(KEY_ENABLED, true).apply()
      val intent = Intent(context, WidgetRefreshService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
      else context.startService(intent)
    }

    fun stop(context: Context) {
      prefs(context).edit().putBoolean(KEY_ENABLED, false).apply()
      context.stopService(Intent(context, WidgetRefreshService::class.java))
    }

    fun isEnabled(context: Context) = prefs(context).getBoolean(KEY_ENABLED, false)

    fun intervalSec(context: Context) = prefs(context).getInt(KEY_INTERVAL, DEFAULT_INTERVAL_SEC)
  }
}
