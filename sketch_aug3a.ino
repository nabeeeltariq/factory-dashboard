#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include "time.h"

// --- Wi-Fi Credentials ---
const char* ssid = "OPTIMIZED";
const char* password = "Opti2019!@";

// --- FIREBASE ENDPOINTS ---
const char* dataUrl = "https://automation-60207-default-rtdb.firebaseio.com/shift_data.json";
const char* controlUrl = "https://automation-60207-default-rtdb.firebaseio.com/shift_control.json";
const char* hourlyUrl = "https://automation-60207-default-rtdb.firebaseio.com/hourly_production.json";
const char* resetUrl = "https://automation-60207-default-rtdb.firebaseio.com/reset_command.json";
const char* breakdownLogUrl = "https://automation-60207-default-rtdb.firebaseio.com/breakdowns.json";
const char* timestampsUrl = "https://automation-60207-default-rtdb.firebaseio.com/shift_timestamps.json"; // NEW: For Start Time

// --- NETLIFY WEBHOOK (AUTO-ARCHIVE) ---
const char* netlifyArchiveUrl = "https://lineview.netlify.app/.netlify/functions/archive-shift";

// --- Pin Definition ---
const int sensorPin = 4;

// --- Shift & Status Variables ---
volatile bool shiftActive = false;
bool lastShiftState = false;
unsigned long lastFirebaseUpdate = 0;
const unsigned long updateInterval = 3000;

// --- Automation Variables ---
bool autoMode = false;
int autoStartHour = 0;
int autoStartMin = 0;
int autoEndHour = 0;
int autoEndMin = 0;
bool autoStartedToday = false;
bool autoEndedToday = false;

// --- Counting Variables ---
volatile int caseCount = 0;
volatile int casesThisHour = 0;
volatile unsigned long lastInterruptTime = 0;
volatile bool newCaseDetected = false;
unsigned long lastCaseTime = 0;

// --- Anti-Jitter Breakdown Variables ---
int resumeCaseCount = 0;
const int casesToResume = 1;

// --- Breakdown Variables ---
const unsigned long breakdownThreshold = 120000;
bool isBreakdownStatus = false;
unsigned long totalBreakdownTime = 0;
unsigned long currentBreakdownStartTime = 0;
time_t currentBreakdownStartEpoch = 0;

struct BreakdownEvent {
  time_t startEpoch;
  unsigned long durationSecs;
};
const int breakdownQueueSize = 6;
BreakdownEvent breakdownQueue[breakdownQueueSize];
int queueHead = 0;
int queueTail = 0;
int queueCount = 0;

void queueBreakdownEvent(time_t startEpoch, unsigned long durationSecs) {
  if (queueCount >= breakdownQueueSize) {
    queueHead = (queueHead + 1) % breakdownQueueSize;
    queueCount--;
  }
  breakdownQueue[queueTail].startEpoch = startEpoch;
  breakdownQueue[queueTail].durationSecs = durationSecs;
  queueTail = (queueTail + 1) % breakdownQueueSize;
  queueCount++;
}

// --- NTP Time Settings (GMT+3) ---
const char* ntpServer = "pool.ntp.org";
const long  gmtOffset_sec = 10800; // 3 hours
const int   daylightOffset_sec = 0;
int currentTrackingHour = -1;

// --- HOURLY PENDING BUFFER VARIABLES ---
bool hasPendingHourlyData = false;
char pendingHourlyLabel[16] = "";
int pendingHourlyCases = 0;

// --- Interrupt Service Routine (ISR) ---
void IRAM_ATTR handleInterrupt() {
  unsigned long interruptTime = millis();
  if (interruptTime - lastInterruptTime > 3500) {
    if (shiftActive) {
      caseCount++;
      casesThisHour++;
      lastInterruptTime = interruptTime;
      newCaseDetected = true;
    }
  }
}

// --- Cloud Boot-Sync Function ---
void syncFromCloud() {
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(dataUrl);
    int httpCode = http.GET();
    if (httpCode > 0) {
      String payload = http.getString();
      int caseIdx = payload.indexOf("\"total_cases\"");
      if (caseIdx > 0) {
        int colonIdx = payload.indexOf(":", caseIdx);
        int endIdx = payload.indexOf(",", colonIdx);
        if(endIdx == -1) endIdx = payload.indexOf("}", colonIdx);
        caseCount = payload.substring(colonIdx + 1, endIdx).toInt();
      }
      int bdIdx = payload.indexOf("\"breakdown_seconds\"");
      if (bdIdx > 0) {
        int colonIdx = payload.indexOf(":", bdIdx);
        int endIdx = payload.indexOf(",", colonIdx);
        if(endIdx == -1) endIdx = payload.indexOf("}", colonIdx);
        totalBreakdownTime = payload.substring(colonIdx + 1, endIdx).toInt() * 1000UL;
      }
    }
    http.end();
  }
}

// --- FIX 1: STAMP START TIME (NEW) ---
void markShiftStartTimestamp() {
  if (WiFi.status() == WL_CONNECTED) {
    time_t nowEpoch;
    time(&nowEpoch);
    // Add "000" to convert ESP32 seconds into JS milliseconds
    String jsonPayload = "{\"start\": " + String(nowEpoch) + "000, \"end\": null}";
    
    HTTPClient http;
    http.begin(timestampsUrl);
    http.addHeader("Content-Type", "application/json");
    http.PUT(jsonPayload);
    http.end();
    Serial.println("Shift Start Timestamp Logged to Firebase.");
  }
}

// --- FIX 2: INSTANT HOURLY FLUSH ---
void flushFinalHourlyData() {
  if (casesThisHour > 0 && currentTrackingHour != -1) {
    sprintf(pendingHourlyLabel, "%02d:00-%02d:00", currentTrackingHour, (currentTrackingHour + 1) % 24);
    Serial.printf("Shift Ended! Force-flushing %s = %d cases to Firebase.\n", pendingHourlyLabel, casesThisHour);
    
    if (WiFi.status() == WL_CONNECTED) {
      HTTPClient http;
      http.begin(hourlyUrl);
      http.addHeader("Content-Type", "application/json");
      char jsonPayload[64];
      sprintf(jsonPayload, "{\"%s\": %d}", pendingHourlyLabel, casesThisHour);
      http.PATCH(jsonPayload);
      http.end();
    }
    casesThisHour = 0; // Clear it instantly so it doesn't duplicate
  }
}

// --- WEBHOOK TRIGGER ---
void triggerNetlifyArchive() {
  Serial.println("Triggering Netlify Webhook to archive data...");
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(netlifyArchiveUrl);
    http.POST(""); 
    http.end();
  }
}

void updateCloudControlState(bool isActive) {
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(controlUrl);
    http.addHeader("Content-Type", "application/json");
    http.PATCH(isActive ? "{\"active\":true}" : "{\"active\":false}");
    http.end();
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(sensorPin, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(sensorPin), handleInterrupt, FALLING);

  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) delay(500);

  configTime(gmtOffset_sec, daylightOffset_sec, ntpServer);
  syncFromCloud();
  lastCaseTime = millis();
}

void loop() {
  unsigned long currentTime = millis();

  // 1. SHIFT-DEPENDENT SENSOR & BREAKDOWN LOGIC
  if (shiftActive) {
    if (newCaseDetected) {
      newCaseDetected = false;
      lastCaseTime = millis();
      if (isBreakdownStatus) {
        resumeCaseCount++;
        if (resumeCaseCount >= casesToResume) {
          unsigned long thisDurationMs = (currentTime - currentBreakdownStartTime);
          totalBreakdownTime += thisDurationMs;
          isBreakdownStatus = false;
          resumeCaseCount = 0;
          queueBreakdownEvent(currentBreakdownStartEpoch, thisDurationMs / 1000);
          currentBreakdownStartEpoch = 0;
        }
      }
    }
    if ((currentTime - lastCaseTime >= breakdownThreshold) && !isBreakdownStatus) {
      isBreakdownStatus = true;
      resumeCaseCount = 0;
      currentBreakdownStartTime = lastCaseTime;
      time_t nowEpoch; time(&nowEpoch);
      currentBreakdownStartEpoch = nowEpoch - ((currentTime - lastCaseTime) / 1000);
    }
  } else {
    lastCaseTime = currentTime;
    resumeCaseCount = 0;
  }

  // 2. AUTO-SCHEDULE LOGIC (UPDATED)
  struct tm timeinfo;
  if (getLocalTime(&timeinfo)) {
    int realHour = timeinfo.tm_hour;
    int realMin = timeinfo.tm_min;

    if (realHour == 0 && realMin == 0) {
      autoStartedToday = false;
      autoEndedToday = false;
    }

    if (autoMode) {
      // AUTO-START
      if (realHour == autoStartHour && realMin == autoStartMin && !autoStartedToday) {
        if (caseCount > 0) triggerNetlifyArchive(); 
        
        shiftActive = true;
        autoStartedToday = true;
        updateCloudControlState(true);
        markShiftStartTimestamp(); // Log exact start time!
        Serial.println("AUTO-SCHEDULE: Shift Started!");
      }
      
      // AUTO-END (Fixing the Race Condition)
      if (realHour == autoEndHour && realMin == autoEndMin && !autoEndedToday) {
        shiftActive = false;
        autoEndedToday = true;
        
        // A. Instantly bank any ongoing breakdown
        if (isBreakdownStatus) {
          unsigned long thisDurationMs = (millis() - currentBreakdownStartTime);
          totalBreakdownTime += thisDurationMs;
          isBreakdownStatus = false;
          queueBreakdownEvent(currentBreakdownStartEpoch, thisDurationMs / 1000);
          currentBreakdownStartEpoch = 0;
        }

        // B. Force push the final hourly data BEFORE Webhook
        flushFinalHourlyData();
        
        // C. Update UI state
        updateCloudControlState(false);
        
        // D. NOW trigger Webhook to archive and wipe
        triggerNetlifyArchive(); 
        Serial.println("AUTO-SCHEDULE: Shift Ended & Archived!");
      }
    }

    // 3. HOURLY PRODUCTION BUFFER LOGIC
    if (currentTrackingHour == -1) currentTrackingHour = realHour;

    if (realHour != currentTrackingHour) {
      int previousHour = currentTrackingHour;
      if (shiftActive || casesThisHour > 0) {
        sprintf(pendingHourlyLabel, "%02d:00-%02d:00", previousHour, realHour);
        pendingHourlyCases = casesThisHour;
        hasPendingHourlyData = true;
      }
      casesThisHour = 0;
      currentTrackingHour = realHour;
    }
  }

  // 4. DATABASE SYNC & RECOVERY
  if (currentTime - lastFirebaseUpdate >= updateInterval) {
    if (WiFi.status() != WL_CONNECTED) {
      WiFi.disconnect(); WiFi.reconnect();
    } else {
      HTTPClient http;
      http.setTimeout(4000);

      // A. Fetch Shift Control & Automation Config
      http.begin(controlUrl);
      if (http.GET() > 0) {
        String payload = http.getString();
        autoMode = (payload.indexOf("\"mode\":\"auto\"") >= 0 || payload.indexOf("\"mode\": \"auto\"") >= 0);
        
        int sIdx = payload.indexOf("\"auto_start\"");
        if (sIdx > 0) {
          int qIdx = payload.indexOf("\"", payload.indexOf(":", sIdx));
          String sStr = payload.substring(qIdx + 1, qIdx + 6);
          autoStartHour = sStr.substring(0, 2).toInt();
          autoStartMin = sStr.substring(3, 5).toInt();
        }
        int eIdx = payload.indexOf("\"auto_end\"");
        if (eIdx > 0) {
          int qIdx = payload.indexOf("\"", payload.indexOf(":", eIdx));
          String eStr = payload.substring(qIdx + 1, qIdx + 6);
          autoEndHour = eStr.substring(0, 2).toInt();
          autoEndMin = eStr.substring(3, 5).toInt();
        }

        if (!autoMode) {
          shiftActive = (payload.indexOf("\"active\": true") >= 0 || payload.indexOf("\"active\":true") >= 0);
        }
      }
      http.end();

      // B. Handle Shift Transitions (Manual & Auto)
      if (shiftActive && !lastShiftState) {
        Serial.println("Shift Resumed/Started! (Counters maintained)");
        lastShiftState = true;
      } else if (!shiftActive && lastShiftState) {
        Serial.println("Shift Paused/Ended!");
        
        if (isBreakdownStatus) {
          unsigned long thisDurationMs = (currentTime - currentBreakdownStartTime);
          totalBreakdownTime += thisDurationMs;
          isBreakdownStatus = false;
          queueBreakdownEvent(currentBreakdownStartEpoch, thisDurationMs / 1000);
          currentBreakdownStartEpoch = 0;
        }

        flushFinalHourlyData(); // Safely flushes if manual shift ended
        lastShiftState = false;
      }

      // C. Process Normal Pending Hourly Data
      if (hasPendingHourlyData) {
        http.begin(hourlyUrl);
        http.addHeader("Content-Type", "application/json");
        char jsonPayload[64];
        sprintf(jsonPayload, "{\"%s\": %d}", pendingHourlyLabel, pendingHourlyCases);
        if (http.PATCH(jsonPayload) == 200) hasPendingHourlyData = false;
        http.end();
      }

      // D. Process Breakdown Queue
      if (queueCount > 0) {
        http.begin(breakdownLogUrl);
        http.addHeader("Content-Type", "application/json");
        char jsonPayload[64];
        snprintf(jsonPayload, sizeof(jsonPayload), "{\"start\":%ld,\"duration\":%lu}",
                 (long)breakdownQueue[queueHead].startEpoch, breakdownQueue[queueHead].durationSecs);
        if (http.POST(jsonPayload) == 200) {
          queueHead = (queueHead + 1) % breakdownQueueSize;
          queueCount--;
        }
        http.end();
      }

      // E. Check for Master Wipe Command
      http.begin(resetUrl);
      if (http.GET() > 0 && http.getString().indexOf("true") >= 0) {
        Serial.println("MASTER RESET RECEIVED! Wiping hardware memory...");
        caseCount = 0;
        casesThisHour = 0;
        totalBreakdownTime = 0;
        isBreakdownStatus = false;
        currentBreakdownStartTime = 0;
        currentBreakdownStartEpoch = 0;
        hasPendingHourlyData = false;
        resumeCaseCount = 0;
        lastCaseTime = millis();
        queueCount = 0;

        HTTPClient wipeHttp;
        wipeHttp.begin(breakdownLogUrl);
        wipeHttp.sendRequest("DELETE");
        wipeHttp.end();

        http.begin(resetUrl);
        http.addHeader("Content-Type", "application/json");
        http.PUT("false");
      }
      http.end();

      // F. Push Live Data
      http.begin(dataUrl);
      http.addHeader("Content-Type", "application/json");
      String statusStr = (!shiftActive) ? "Shift Inactive" : (isBreakdownStatus ? "Stopped" : "Running");
      unsigned long currentBreakdownDisplay = totalBreakdownTime;
      if (isBreakdownStatus && shiftActive) currentBreakdownDisplay += (currentTime - currentBreakdownStartTime);

      char jsonPayload[190];
      snprintf(jsonPayload, sizeof(jsonPayload),
               "{\"total_cases\": %d, \"line_status\": \"%s\", \"breakdown_seconds\": %d, \"heartbeat\": %lu, \"active_breakdown_start\": %ld}",
               caseCount, statusStr.c_str(), currentBreakdownDisplay / 1000, millis(), (long)currentBreakdownStartEpoch);
      http.PATCH(jsonPayload);
      http.end();
    }
    lastFirebaseUpdate = currentTime;
  }
}