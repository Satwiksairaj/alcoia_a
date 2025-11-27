import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import axios from "axios";
import Constants from "expo-constants";

/* ----------------------------- CONSTANTS ----------------------------- */

const extra = Constants.expoConfig?.extra ?? {};
const API_BASE_URL = extra.apiUrl ?? "http://localhost:5000/api";
const STUDENT_ID = extra.studentId ?? "student 123";
const POLL_INTERVAL_MS = 10000;

// 3-second grace period for false background/blur triggers
const FOCUS_LOSS_GRACE_MS = 3000;

const STATUS_TEXT = {
  normal: "All clear",
  needs_intervention: "Mentor review pending",
  remedial: "Remedial task assigned",
};

const STATUS_STYLES = {
  normal: "statusNormal",
  needs_intervention: "statusLocked",
  remedial: "statusRemedial",
};

const STATUS_POLL_REQUIRED = new Set(["needs_intervention", "remedial"]);

/* ----------------------------- BUTTON ----------------------------- */

const Button = React.memo(({ label, variant = "primary", onPress, disabled, style }) => (
  <TouchableOpacity
    activeOpacity={0.85}
    style={[
      styles.button,
      styles[variant] ?? styles.primary,
      disabled && styles.buttonDisabled,
      style,
    ]}
    onPress={onPress}
    disabled={disabled}
  >
    <Text
      style={[
        styles.buttonLabel,
        variant === "secondary" && styles.buttonLabelSecondary,
        disabled && styles.buttonLabelDisabled,
      ]}
    >
      {label}
    </Text>
  </TouchableOpacity>
));

/* ----------------------------- MAIN APP ----------------------------- */

const App = () => {
  const [studentStatus, setStudentStatus] = useState("normal");
  const [intervention, setIntervention] = useState(null);
  const [quizScore, setQuizScore] = useState("");
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const [focusSeconds, setFocusSeconds] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [activityLog, setActivityLog] = useState([]);
  const [focusViolation, setFocusViolation] = useState(false);

  const focusSecondsRef = useRef(0);
  const isTimerRunningRef = useRef(false);

  const appStateRef = useRef(AppState.currentState);
  const pollRef = useRef(null);
  const timerRef = useRef(null);
  const axiosSourceRef = useRef(null);
  const focusLossTimerRef = useRef(null);

  /* ----------------------------- LOGGING ----------------------------- */

  const addActivityLog = useCallback((message) => {
    const timestamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    setActivityLog((prev) => [{ id: Date.now().toString(), message, timestamp }, ...prev].slice(0, 25));
  }, []);

  /* ----------------------------- TIME FORMAT ----------------------------- */

  const formatTime = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  /* ----------------------------- FETCH STATUS ----------------------------- */

  const fetchStudentStatus = useCallback(
    async ({ showSpinner = true } = {}) => {
      if (axiosSourceRef.current) axiosSourceRef.current.cancel();

      axiosSourceRef.current = axios.CancelToken.source();
      try {
        if (showSpinner) setIsLoading(true);

        const response = await axios.get(`${API_BASE_URL}/student/${STUDENT_ID}/status`, {
          cancelToken: axiosSourceRef.current.token,
        });

        setStudentStatus(response.data.student?.status ?? "normal");
        setIntervention(response.data.intervention ?? null);
        addActivityLog("Synced status with server");
      } catch (err) {
        if (!axios.isCancel(err)) {
          addActivityLog("Failed to sync status");
          Alert.alert("Sync failed", "Could not fetch the latest status.");
        }
      } finally {
        if (showSpinner) setIsLoading(false);
      }
    },
    [addActivityLog]
  );

  /* ----------------------------- REPORT CHEAT ----------------------------- */

  const reportCheat = useCallback(
    async (reason) => {
      try {
        await axios.post(`${API_BASE_URL}/report-cheat`, {
          student_id: STUDENT_ID,
          focus_duration: formatTime(focusSecondsRef.current),
          reason,
        });

        addActivityLog("Focus violation reported");
        fetchStudentStatus({ showSpinner: false });
      } catch {
        addActivityLog("Failed to notify mentor");
      }
    },
    [fetchStudentStatus, addActivityLog]
  );

  /* ----------------------------- HANDLE FOCUS LOSS (GRACE FIX) ----------------------------- */

  const handleFocusLoss = useCallback(
    (reason) => {
      if (!isTimerRunningRef.current) return;

      // Cancel previously pending violation
      if (focusLossTimerRef.current) clearTimeout(focusLossTimerRef.current);

      // Grace period: Only mark violation if user stays away > 3 seconds
      focusLossTimerRef.current = setTimeout(() => {
        if (!isTimerRunningRef.current) return;

        setIsTimerRunning(false);
        isTimerRunningRef.current = false;
        setFocusViolation(true);
        setStudentStatus("needs_intervention");
        addActivityLog("Focus interrupted");
        reportCheat(reason);
      }, FOCUS_LOSS_GRACE_MS);
    },
    [reportCheat, addActivityLog]
  );

  /* ----------------------------- WEB + APPSTATE LISTENERS ----------------------------- */

  useEffect(() => {
    if (Platform.OS === "web") {
      const onVisible = () => {
        if (!document.hidden) {
          if (focusLossTimerRef.current) clearTimeout(focusLossTimerRef.current);
        }
      };

      const onBlur = () => handleFocusLoss("window blurred");
      const onHidden = () => document.hidden && handleFocusLoss("window hidden");

      window.addEventListener("blur", onBlur);
      document.addEventListener("visibilitychange", onHidden);
      document.addEventListener("visibilitychange", onVisible);

      return () => {
        window.removeEventListener("blur", onBlur);
        document.removeEventListener("visibilitychange", onHidden);
        document.removeEventListener("visibilitychange", onVisible);
      };
    }

    const sub = AppState.addEventListener("change", (nextState) => {
      const wasActive = appStateRef.current === "active";
      appStateRef.current = nextState;

      if (wasActive && nextState === "background") {
        handleFocusLoss("app backgrounded");
      }
    });

    return () => sub.remove();
  }, [handleFocusLoss]);

  /* ----------------------------- TIMER EFFECT ----------------------------- */

  useEffect(() => {
    if (!isTimerRunning) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }

    timerRef.current = setInterval(() => {
      focusSecondsRef.current += 1;
      setFocusSeconds((v) => v + 1);
    }, 1000);

    return () => clearInterval(timerRef.current);
  }, [isTimerRunning]);

  /* ----------------------------- INITIAL FETCH ----------------------------- */

  useEffect(() => {
    fetchStudentStatus();
  }, []);

  /* ----------------------------- POLLING MODE ----------------------------- */

  useEffect(() => {
    if (!STATUS_POLL_REQUIRED.has(studentStatus)) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }

    pollRef.current = setInterval(() => {
      fetchStudentStatus({ showSpinner: false });
    }, POLL_INTERVAL_MS);

    return () => clearInterval(pollRef.current);
  }, [studentStatus]);

  /* ----------------------------- ACTION HANDLERS ----------------------------- */

  const startTimer = () => {
    setFocusViolation(false);
    setIsTimerRunning(true);
    isTimerRunningRef.current = true;

    if (focusLossTimerRef.current) clearTimeout(focusLossTimerRef.current);
    addActivityLog("Focus session started");
  };

  const stopTimer = () => {
    setIsTimerRunning(false);
    isTimerRunningRef.current = false;

    if (focusLossTimerRef.current) clearTimeout(focusLossTimerRef.current);
    addActivityLog(`Focus stopped at ${formatTime(focusSecondsRef.current)}`);
  };

  const resetTimer = () => {
    setIsTimerRunning(false);
    isTimerRunningRef.current = false;
    setFocusSeconds(0);
    focusSecondsRef.current = 0;
    setFocusViolation(false);

    if (focusLossTimerRef.current) clearTimeout(focusLossTimerRef.current);
    addActivityLog("Timer reset");
  };

  /* ----------------------------- DAILY CHECKIN ----------------------------- */

  const submitDailyCheckin = async () => {
    const num = Number(quizScore.trim());
    if (!num || num < 1 || num > 10) return Alert.alert("Invalid", "Score must be 1–10");

    try {
      setIsLoading(true);

      await axios.post(`${API_BASE_URL}/daily-checkin`, {
        student_id: STUDENT_ID,
        quiz_score: num,
        focus_duration: formatTime(focusSecondsRef.current),
      });

      addActivityLog("Daily check-in submitted");
      setQuizScore("");

      fetchStudentStatus({ showSpinner: false });
      Alert.alert("Submitted", "Mentor will review soon.");
    } catch {
      addActivityLog("Check-in failed");
      Alert.alert("Error", "Could not submit check-in.");
    } finally {
      setIsLoading(false);
    }
  };

  /* ----------------------------- COMPLETE INTERVENTION ----------------------------- */

  const completeIntervention = async () => {
    if (!intervention) return;

    try {
      setIsLoading(true);

      await axios.post(`${API_BASE_URL}/complete-intervention`, {
        student_id: STUDENT_ID,
        intervention_id: intervention.id,
        focus_duration: formatTime(focusSecondsRef.current),
      });

      addActivityLog("Remedial task completed");
      setIntervention(null);
      setStudentStatus("normal");
      setFocusViolation(false);

      fetchStudentStatus({ showSpinner: false });
    } catch {
      addActivityLog("Failed to complete task");
      Alert.alert("Error", "Could not complete the task.");
    } finally {
      setIsLoading(false);
    }
  };

  /* ----------------------------- RENDER ----------------------------- */

  const focusLabel = useMemo(() => formatTime(focusSeconds), [focusSeconds]);

  const renderActivity = useCallback(
    ({ item }) => (
      <View style={styles.logRow}>
        <Text style={styles.logTimestamp}>{item.timestamp}</Text>
        <Text style={styles.logMessage}>{item.message}</Text>
      </View>
    ),
    []
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Alcovia Intervention Engine</Text>
          <Text style={styles.subtitle}>Student Focus Mode</Text>
        </View>

        <View style={styles.card}>
          {/* STATUS BADGE */}
          <View
            style={[
              styles.statusBadge,
              styles[STATUS_STYLES[studentStatus]] ?? styles.statusNormal,
            ]}
          >
            <Text style={styles.statusText}>{STATUS_TEXT[studentStatus]}</Text>
          </View>

          {/* NORMAL MODE */}
          {studentStatus === "normal" && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Focus Timer</Text>

              <View style={[styles.timerDisplay, focusViolation && styles.timerWarning]}>
                <Text style={styles.timerValue}>{focusLabel}</Text>
              </View>

              <View style={styles.buttonRow}>
                <Button label="Start" onPress={startTimer} disabled={isTimerRunning || isLoading} />
                <Button label="Stop" variant="danger" onPress={stopTimer} disabled={!isTimerRunning || isLoading} />
                <Button label="Reset" variant="secondary" onPress={resetTimer} disabled={isLoading} />
              </View>

              {focusViolation && (
                <View style={styles.warningBox}>
                  <Text style={styles.warningTitle}>Focus violation detected</Text>
                  <Text style={styles.warningBody}>
                    Keep the app active during focus sessions. Your mentor has been notified.
                  </Text>
                </View>
              )}

              <View style={styles.sectionDivider} />

              {/* DAILY QUIZ */}
              <Text style={styles.sectionTitle}>Daily Quiz Score</Text>
              <Text style={styles.sectionHint}>Enter a score 1–10</Text>

              <TextInput
                style={styles.input}
                value={quizScore}
                onChangeText={setQuizScore}
                keyboardType="numeric"
                maxLength={2}
                placeholder="10"
                placeholderTextColor="#9ca3af"
              />

              <Button
                label={isLoading ? "Submitting…" : "Submit Daily Check-in"}
                variant="success"
                onPress={submitDailyCheckin}
                disabled={isLoading}
                style={styles.fullWidthButton}
              />
            </View>
          )}

          {/* NEEDS INTERVENTION */}
          {studentStatus === "needs_intervention" && (
            <View style={styles.sectionCentered}>
              <Text style={styles.lockedEmoji}>🔒</Text>
              <Text style={styles.sectionTitle}>Analysis in progress</Text>
              <Text style={styles.sectionHintCentered}>
                Mentor review in progress. Please wait for instructions.
              </Text>

              {isLoading && <ActivityIndicator color="#6366f1" style={styles.spinner} />}

              <Button
                label="Refresh Status"
                onPress={() => fetchStudentStatus()}
                disabled={isLoading}
                style={styles.fullWidthButton}
              />
            </View>
          )}

          {/* REMEDIAL TASK */}
          {studentStatus === "remedial" && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Remedial Task</Text>

              <View style={styles.taskBox}>
                <Text style={styles.taskLabel}>Task</Text>
                <Text style={styles.taskBody}>{intervention?.task_description}</Text>
              </View>

              <Button
                label={isLoading ? "Sending…" : "Mark Complete"}
                variant="success"
                onPress={completeIntervention}
                disabled={isLoading}
                style={styles.fullWidthButton}
              />
            </View>
          )}

          {/* LOG */}
          {activityLog.length > 0 && (
            <View style={styles.logSection}>
              <Text style={styles.sectionTitle}>Recent Activity</Text>

              <FlatList
                data={activityLog}
                renderItem={renderActivity}
                keyExtractor={(item) => item.id}
                ItemSeparatorComponent={() => <View style={styles.logDivider} />}
              />
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};

/* ----------------------------- STYLES ----------------------------- */

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#050915" },
  container: { paddingHorizontal: 20, paddingBottom: 48 },
  header: { marginTop: 36, alignItems: "center" },
  title: { fontSize: 26, fontWeight: "800", color: "#F8FAFF" },
  subtitle: { fontSize: 16, color: "#A5B4FF", marginTop: 6 },
  card: {
    marginTop: 28, backgroundColor: "#101a33", borderRadius: 24, padding: 24,
    borderWidth: 1, borderColor: "rgba(99,102,241,0.2)", elevation: 10,
  },

  statusBadge: {
    alignSelf: "flex-start", paddingVertical: 8, paddingHorizontal: 16,
    borderRadius: 999, marginBottom: 24, borderWidth: 1.1,
  },
  statusNormal: { backgroundColor: "rgba(34,197,94,0.18)", borderColor: "rgba(34,197,94,0.45)" },
  statusLocked: { backgroundColor: "rgba(239,68,68,0.15)", borderColor: "rgba(239,68,68,0.45)" },
  statusRemedial: { backgroundColor: "rgba(250,204,21,0.18)", borderColor: "rgba(250,204,21,0.45)" },
  statusText: { color: "#F9FBFF", fontWeight: "700" },

  section: { marginBottom: 28 },
  sectionCentered: { alignItems: "center", paddingVertical: 32 },
  sectionTitle: { fontSize: 19, fontWeight: "700", color: "#E4E9FF", marginBottom: 14 },
  sectionHint: { fontSize: 14, color: "#9EA7FF" },
  sectionHintCentered: {
    fontSize: 15, color: "#C0C8FF", textAlign: "center",
    marginTop: 10, marginHorizontal: 18, lineHeight: 22,
  },

  sectionDivider: { height: 1, backgroundColor: "rgba(79,85,210,0.25)", marginVertical: 24 },

  timerDisplay: {
    backgroundColor: "rgba(54,64,128,0.22)", borderRadius: 18, paddingVertical: 22,
    alignItems: "center", borderWidth: 1, borderColor: "rgba(99,102,241,0.45)", marginBottom: 18,
  },
  timerWarning: { borderColor: "rgba(255,159,67,0.7)", backgroundColor: "rgba(255,159,67,0.16)" },
  timerValue: { fontSize: 38, fontWeight: "800", color: "#F4F6FF", letterSpacing: 2 },

  buttonRow: { flexDirection: "row", justifyContent: "space-between" },

  button: {
    flex: 1, marginHorizontal: 5, paddingVertical: 16,
    borderRadius: 14, alignItems: "center", borderWidth: 1,
    borderColor: "rgba(99,102,241,0.2)",
  },
  buttonLabel: { fontWeight: "700", color: "#f9fbff", fontSize: 15 },
  buttonLabelSecondary: { color: "#e2e8f0" },
  buttonLabelDisabled: { color: "rgba(249,251,255,0.55)" },
  fullWidthButton: { marginTop: 18 },

  buttonDisabled: { opacity: 0.55 },
  primary: { backgroundColor: "#6366f1" },
  danger: { backgroundColor: "#f87171" },
  secondary: { backgroundColor: "#1f2937" },
  success: { backgroundColor: "#22c55e" },

  input: {
    backgroundColor: "rgba(18,24,46,0.9)", borderRadius: 14,
    paddingVertical: 13, paddingHorizontal: 18, fontSize: 16,
    color: "#F5F7FF", borderWidth: 1, borderColor: "rgba(129,140,248,0.45)", marginTop: 10,
  },

  warningBox: {
    backgroundColor: "rgba(255,159,67,0.16)", borderRadius: 14,
    padding: 16, borderWidth: 1, borderColor: "rgba(255,171,89,0.45)",
  },
  warningTitle: { fontWeight: "700", color: "#FDBA74", marginBottom: 6 },
  warningBody: { color: "#FFEAD1", lineHeight: 21 },

  lockedEmoji: { fontSize: 52, marginBottom: 14 },
  spinner: { marginVertical: 18 },

  taskBox: {
    backgroundColor: "rgba(64,73,140,0.35)", borderRadius: 16,
    padding: 18, borderWidth: 1, borderColor: "rgba(129,140,248,0.4)", marginBottom: 18,
  },
  taskLabel: { color: "#C7D2FF", fontWeight: "700", marginBottom: 6 },
  taskBody: { color: "#E8ECFF", fontSize: 16, lineHeight: 23 },

  logSection: { marginTop: 14 },
  logRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 7 },
  logTimestamp: { color: "#9CA8FF", fontSize: 12, fontWeight: "600", width: 86 },
  logMessage: { color: "#EEF2FF", flex: 1, fontSize: 14, marginLeft: 8 },
  logDivider: { height: 1, backgroundColor: "rgba(79,85,210,0.2)" },
});

export default App;
