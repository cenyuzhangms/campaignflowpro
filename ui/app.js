const { useCallback, useEffect, useMemo, useRef, useState } = React;

let _eventId = 0;
function nextEventId() {
  return ++_eventId;
}

const agentPalette = {
  Planner: { color: "#6aa6ff", label: "GitHub Copilot" },
  Writer: { color: "#9b7bff", label: "Claude" },
  Reviewer: { color: "#5bd0c5", label: "Azure OpenAI" },
  Publisher: { color: "#f2b36e", label: "Claude" },
};

const phaseToAgent = {
  planner: "Planner",
  writer: "Writer",
  reviewer: "Reviewer",
  publisher: "Publisher",
};

const defaultForm = {
  brief: "Launch a spring campaign for a new productivity app.",
  goal: "Drive qualified demo sign-ups",
  audience: "Busy professionals and team leads",
  channels: "Email, LinkedIn, Website",
  tone: "Confident, optimistic, helpful",
  brand_constraints: "No medical claims; keep CTA direct",
  loop_limit: 2,
};

function App() {
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState([]);
  const [agentStatus, setAgentStatus] = useState({});
  const [reviewDecision, setReviewDecision] = useState(null);
  const [needsHuman, setNeedsHuman] = useState(null);
  const [needsApproval, setNeedsApproval] = useState(null);
  const [finalOutput, setFinalOutput] = useState(null);
  const [systemInfo, setSystemInfo] = useState(null);
  const [errorState, setErrorState] = useState(null);
  const [showDiagnostics, setShowDiagnostics] = useState(true);
  const [showApprovalModal, setShowApprovalModal] = useState(false);
  const [approvalHistory, setApprovalHistory] = useState([]);
  const [approvalNote, setApprovalNote] = useState("");
  const [approvalState, setApprovalState] = useState("Waiting");
  const [isRunning, setIsRunning] = useState(false);
  const [activeTimers, setActiveTimers] = useState({});
  const [nowTick, setNowTick] = useState(Date.now());
  const [form, setForm] = useState(defaultForm);
  const [humanNote, setHumanNote] = useState("");
  const [publishedHistory, setPublishedHistory] = useState([]);
  const [selectedPublished, setSelectedPublished] = useState(null);
  const [theme, setTheme] = useState(() => {
    const stored = localStorage.getItem("cf_theme");
    if (stored === "dark" || stored === "light") return stored;
    return "light";
  });
  const [terminalInput, setTerminalInput] = useState("");
  const [terminalLog, setTerminalLog] = useState([
    "CampaignFlow Terminal v1",
    "Type 'help' to see commands.",
  ]);
  const [launchCollapsed, setLaunchCollapsed] = useState(false);
  const [showPackagesDrawer, setShowPackagesDrawer] = useState(false);
  const [packageSearch, setPackageSearch] = useState("");
  const wsRef = useRef(null);
  const handleEventRef = useRef(null);
  const themeRef = useRef(theme);
  const terminalBodyRef = useRef(null);

  const handleEvent = useCallback((data) => {
    const { type, payload } = data;
    if (type === "system") {
      setSystemInfo(payload);
    }
    if (type === "status") {
      setAgentStatus((prev) => ({ ...prev, [payload.phase]: payload.message }));
      if (payload.message && payload.message.toLowerCase().includes("cancelled")) {
        setIsRunning(false);
        setActiveTimers({});
      }
      if (payload.message && payload.message.toLowerCase().includes("started")) {
        setActiveTimers((prev) => ({ ...prev, [payload.phase]: Date.now() }));
      }
      if (payload.message && payload.message.toLowerCase().includes("completed")) {
        setActiveTimers((prev) => {
          const next = { ...prev };
          delete next[payload.phase];
          return next;
        });
      }
    }
    if (type === "agent_message") {
      setEvents((prev) => [
        { id: nextEventId(), kind: "agent", agent: payload.agent, content: payload.content },
        ...prev,
      ]);
      if (themeRef.current === "terminal") {
        appendTerminal(`${payload.agent}: ${payload.content}`);
      }
    }
    if (type === "review_decision") {
      setReviewDecision(payload);
      if (themeRef.current === "terminal") {
        appendTerminal(`Reviewer decision: ${payload.approved ? "Approved" : "Needs changes"}`);
      }
    }
    if (type === "needs_human") {
      setNeedsHuman(payload);
    }
    if (type === "needs_approval") {
      setNeedsApproval(payload);
      setShowApprovalModal(true);
      setApprovalState("Pending");
    }
    if (type === "final_output") {
      setFinalOutput(payload);
      const name = payload.name || `Campaign ${new Date().toLocaleTimeString()}`;
      setPublishedHistory((prev) => [
        { ...payload, time: payload.time || new Date().toLocaleTimeString(), name },
        ...prev,
      ]);
      setSelectedPublished({ ...payload, name });
    }
    if (type === "published") {
      setIsRunning(false);
      setActiveTimers({});
      setApprovalState("Published");
      setEvents((prev) => [
        { id: nextEventId(), kind: "system", title: "Published", content: payload.message },
        ...prev,
      ]);
      if (themeRef.current === "terminal") {
        appendTerminal(`Published: ${payload.message}`);
      }
    }
    if (type === "published_history") {
      const items = (payload.items || []).map((item) => ({
        ...item,
        name: item.name || `Campaign ${item.time || ""}`,
      }));
      setPublishedHistory(items);
      if (items.length && !selectedPublished) {
        setSelectedPublished(items[0]);
      }
    }
    if (type === "workflow_event") {
      setEvents((prev) => [
        {
          id: nextEventId(),
          kind: "system",
          title: "Workflow",
          content: `${payload.phase}: ${payload.event}${payload.details ? ` - ${payload.details}` : ""}`,
        },
        ...prev,
      ]);
      if (themeRef.current === "terminal") {
        appendTerminal(`Workflow ${payload.phase}: ${payload.event}`);
      }
    }
    if (type === "error") {
      setIsRunning(false);
      setActiveTimers({});
      setErrorState(payload);
      setShowDiagnostics(true);
      setEvents((prev) => [
        { id: nextEventId(), kind: "system", title: "Error", content: payload.message },
        ...prev,
      ]);
    }
  }, []);

  const diagnosticsItems = useMemo(() => {
    const details = errorState && errorState.details ? errorState.details : "";
    const lower = details.toLowerCase();
    return [
      {
        label: "Install Agent Framework SDKs",
        value: "pip install -r requirements.txt",
        ok: !lower.includes("no module named"),
      },
      {
        label: "Copilot CLI on PATH",
        value: "where copilot",
        ok: !lower.includes("copilot"),
      },
      {
        label: "Claude CLI on PATH",
        value: "where claude",
        ok: !lower.includes("claude"),
      },
      {
        label: "Azure OpenAI env vars set",
        value: "AZURE_OPENAI_ENDPOINT / DEPLOYMENT / API_KEY",
        ok: !lower.includes("azure"),
      },
    ];
  }, [errorState]);

  handleEventRef.current = handleEvent;

  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      handleEventRef.current(data);
    };

    return () => ws.close();
  }, []);

  useEffect(() => {
    document.body.setAttribute("data-theme", theme);
    localStorage.setItem("cf_theme", theme);
    themeRef.current = theme;
  }, [theme]);

  useEffect(() => {
    if (theme !== "terminal") {
      setLaunchCollapsed(false);
      return;
    }
    const node = terminalBodyRef.current;
    if (!node) return;
    const onScroll = () => {
      const shouldCollapse = node.scrollTop > 40;
      setLaunchCollapsed(shouldCollapse);
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, [theme]);

  const send = (type, payload) => {
    if (!wsRef.current || wsRef.current.readyState !== 1) return;
    wsRef.current.send(JSON.stringify({ type, payload }));
  };

  const startWorkflow = () => {
    setEvents([]);
    setNeedsHuman(null);
    setNeedsApproval(null);
    setFinalOutput(null);
    setReviewDecision(null);
    setAgentStatus({});
    setActiveTimers({});
    setIsRunning(true);
    setApprovalState("Waiting");
    setSelectedPublished(null);

    send("start_workflow", {
      ...form,
      channels: form.channels.split(",").map((c) => c.trim()).filter(Boolean),
      loop_limit: Number(form.loop_limit || 2),
    });
  };

  const submitHumanFeedback = () => {
    if (!humanNote.trim()) return;
    send("human_feedback", { message: humanNote });
    setHumanNote("");
    setNeedsHuman(null);
  };

  const approvePublish = () => {
    send("human_approve", { approved: true });
    if (approvalNote.trim()) {
      setApprovalHistory((prev) => [
        ...prev,
        { note: approvalNote.trim(), time: new Date().toLocaleTimeString() },
      ]);
      setApprovalNote("");
    }
    setShowApprovalModal(false);
    setNeedsApproval(null);
    setApprovalState("Approved");
  };

  const holdApproval = () => {
    if (approvalNote.trim()) {
      setApprovalHistory((prev) => [
        ...prev,
        { note: approvalNote.trim(), time: new Date().toLocaleTimeString() },
      ]);
      setApprovalNote("");
    }
    setShowApprovalModal(false);
    setApprovalState("On hold");
    setEvents((prev) => [
      {
        id: nextEventId(),
        kind: "system",
        title: "Approval",
        content: "Final approval placed on hold.",
      },
      ...prev,
    ]);
  };

  const getAgentDisplayStatus = (name) => {
    const agentKey = Object.entries(phaseToAgent).find(([, v]) => v === name);
    if (!agentKey) return "Ready";
    const msg = agentStatus[agentKey[0]];
    if (!msg) return "Ready";
    return msg;
  };

  const isAgentActive = (name) => {
    const agentKey = Object.entries(phaseToAgent).find(([, v]) => v === name);
    if (!agentKey) return false;
    const msg = agentStatus[agentKey[0]] || "";
    return msg.toLowerCase().includes("started") || msg.toLowerCase().includes("drafting") || msg.toLowerCase().includes("evaluating") || msg.toLowerCase().includes("preparing");
  };

  const formatElapsed = (phase) => {
    const start = activeTimers[phase];
    if (!start) return "";
    const seconds = Math.floor((nowTick - start) / 1000);
    return `${seconds}s`;
  };

  const latestEvents = useMemo(() => events, [events]);
  const filteredPackages = useMemo(() => {
    if (!packageSearch.trim()) return publishedHistory;
    const term = packageSearch.trim().toLowerCase();
    return publishedHistory.filter((item) =>
      (item.name || "").toLowerCase().includes(term)
    );
  }, [packageSearch, publishedHistory]);

  const appendTerminal = (line) => {
    setTerminalLog((prev) => [...prev, line]);
  };

  const terminalStatus = () => {
    const lines = Object.keys(phaseToAgent).map((phase) => {
      const name = phaseToAgent[phase];
      const status = agentStatus[phase] || "Ready";
      return `${name}: ${status}`;
    });
    lines.forEach((line) => appendTerminal(line));
  };

  const handleTerminalCommand = (raw) => {
    const cmd = raw.trim().toLowerCase();
    if (!cmd) return;
    appendTerminal(`> ${raw}`);
    if (cmd === "help") {
      appendTerminal("Commands: run, status, cancel, approve, hold, help");
      return;
    }
    if (cmd === "run") {
      startWorkflow();
      appendTerminal("Workflow started.");
      terminalStatus();
      return;
    }
    if (cmd === "status") {
      terminalStatus();
      return;
    }
    if (cmd === "cancel") {
      send("cancel_workflow", {});
      appendTerminal("Cancel requested.");
      return;
    }
    if (cmd === "approve") {
      approvePublish();
      appendTerminal("Approval submitted.");
      return;
    }
    if (cmd === "hold") {
      holdApproval();
      appendTerminal("Approval placed on hold.");
      return;
    }
    appendTerminal("Unknown command. Type 'help'.");
  };

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <div className="brand-mark">CF</div>
          <div>
            <h1>CampaignFlow <span>Pro</span></h1>
            <p>Multi-agent marketing workflow with human approval gates</p>
          </div>
        </div>
        <div className="badge-row">
          <span className="badge-pill maf">Microsoft Agent Framework</span>
          <span className="badge-pill azure">Azure OpenAI</span>
          <span className="badge-pill claude">Claude</span>
          <span className="badge-pill copilot">GitHub Copilot</span>
        </div>
        <div className="header-actions">
          <div className="theme-toggle">
            <button
              className={`chip ${theme === "light" ? "active" : ""}`}
              onClick={() => setTheme("light")}
            >
              Light
            </button>
            <button
              className={`chip ${theme === "dark" ? "active" : ""}`}
              onClick={() => setTheme("dark")}
            >
              Dark
            </button>
            <button
              className={`chip ${theme === "terminal" ? "active" : ""}`}
              onClick={() => setTheme("terminal")}
            >
              Terminal
            </button>
          </div>
          <div className="status-pill">
            <span className={connected ? "dot ok" : "dot warn"}></span>
            {isRunning ? "Running..." : connected ? "Connected" : "Offline"}
          </div>
          <button className="profile-chip">
            <span className="avatar">You</span>
            <span className="caret">▼</span>
          </button>
        </div>
      </header>

      <section className="layout">
        <main className="left">
          <section className={`card launch ${launchCollapsed ? "collapsed" : ""}`}>
            <div className="launch-header">
              <div>
                <h2>Launch Request</h2>
                <p>Provide the campaign brief and guide the execution.</p>
              </div>
              <div className="launch-actions">
                <button className="ghost" onClick={() => send("cancel_workflow", {})} disabled={!isRunning}>
                  Cancel workflow
                </button>
                <button className="primary" onClick={startWorkflow} disabled={!!errorState || isRunning}>
                  {isRunning ? "Running..." : "Start workflow"}
                </button>
              </div>
            </div>

            <div className="form-grid">
              <div>
                <label>Brief</label>
                <input
                  value={form.brief}
                  onChange={(e) => setForm({ ...form, brief: e.target.value })}
                />
              </div>
              <div>
                <label>Goal</label>
                <input
                  value={form.goal}
                  onChange={(e) => setForm({ ...form, goal: e.target.value })}
                />
              </div>
              <div>
                <label>Audience</label>
                <input
                  value={form.audience}
                  onChange={(e) => setForm({ ...form, audience: e.target.value })}
                />
              </div>
              <div>
                <label>Channels</label>
                <input
                  value={form.channels}
                  onChange={(e) => setForm({ ...form, channels: e.target.value })}
                />
              </div>
              <div>
                <label>Tone</label>
                <input
                  value={form.tone}
                  onChange={(e) => setForm({ ...form, tone: e.target.value })}
                />
              </div>
              <div>
                <label>Brand constraints</label>
                <input
                  value={form.brand_constraints}
                  onChange={(e) => setForm({ ...form, brand_constraints: e.target.value })}
                />
              </div>
              <div>
                <label>Review loop limit</label>
                <input
                  type="number"
                  min="1"
                  max="5"
                  value={form.loop_limit}
                  onChange={(e) => setForm({ ...form, loop_limit: e.target.value })}
                />
              </div>
            </div>
          </section>

          <section className="card flow">
            <div className="flow-header">
              <h3>Execution Flow</h3>
              <span className="muted">Writer  Reviewer loop</span>
            </div>
            <div className="flow-row">
              {Object.entries(agentPalette).map(([name, meta], idx) => (
                <div className={`flow-card ${isAgentActive(name) ? "active" : ""}`} key={name}>
                  <div className="flow-icon" style={{ background: meta.color }}>
                    {name[0]}
                  </div>
                  <div className="flow-meta">
                    <h4>{name}</h4>
                    <span>{meta.label}</span>
                    <div className={`flow-status ${isAgentActive(name) ? "active" : "idle"}`}>
                      {getAgentDisplayStatus(name)}
                    </div>
                    {formatElapsed(Object.keys(phaseToAgent).find((k) => phaseToAgent[k] === name)) && (
                      <div className="timer-pill">
                        {formatElapsed(Object.keys(phaseToAgent).find((k) => phaseToAgent[k] === name))}
                      </div>
                    )}
                  </div>
                  {idx < 3 && <div className="flow-arrow">→</div>}
                </div>
              ))}
              <div
                className={`loop-connector ${isAgentActive("Writer") || isAgentActive("Reviewer") ? "active" : ""}`}
                aria-hidden="true"
              ></div>
            </div>
          </section>

          {theme !== "terminal" && (
          <section className="card feed">
            <div className="feed-header">
              <h3>Live Execution Feed</h3>
              <span className="muted">Just now</span>
            </div>
            {errorState && (
              <div className="error-banner">
                <div className="error-banner-header">
                  <strong>Setup error:</strong> {errorState.message}
                  <button className="ghost" onClick={() => setShowDiagnostics((prev) => !prev)}>
                    {showDiagnostics ? "Hide" : "Show"} diagnostics
                  </button>
                </div>
                {errorState.details && <span className="error-details">{errorState.details}</span>}
                {showDiagnostics && (
                  <div className="diagnostics-panel">
                    <h4>Startup diagnostics</h4>
                    <ul>
                      {diagnosticsItems.map((item) => (
                        <li key={item.label} className={item.ok ? "ok" : "warn"}>
                          <span>{item.label}</span>
                          <em>{item.value}</em>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            <div className="feed-list">
              {latestEvents.length === 0 && (
                <div className="feed-item empty">
                  <h4>Waiting for input</h4>
                  <p>Start a workflow to see agents respond here.</p>
                </div>
              )}
              {latestEvents.map((event) => (
                <div className="feed-item" key={event.id}>
                  <div className="feed-avatar">{(event.agent || event.title || "S")[0]}</div>
                  <div>
                    <h4>{event.agent || event.title}</h4>
                    <p>{event.content}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="feed-input">
              <input
                placeholder="Customize the execution or intervene directly..."
                value={humanNote}
                onChange={(e) => setHumanNote(e.target.value)}
                disabled={!needsHuman}
              />
              <button className="primary" onClick={submitHumanFeedback} disabled={!needsHuman}>
                Send
              </button>
            </div>
            <p className="hint-text">
              Send feedback when a human-in-the-loop request appears.
            </p>
          </section>
          )}

          {theme === "terminal" && (
            <section className={`card terminal ${launchCollapsed ? "expanded" : ""}`}>
              <div className="terminal-header">Terminal Mode</div>
              <div className="terminal-body" ref={terminalBodyRef}>
                {terminalLog.map((line, idx) => (
                  <div key={`${line}-${idx}`} className="terminal-line">
                    {line}
                  </div>
                ))}
              </div>
              <div className="terminal-input">
                <span className="prompt">cf&gt;</span>
                <input
                  value={terminalInput}
                  onChange={(e) => setTerminalInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      handleTerminalCommand(terminalInput);
                      setTerminalInput("");
                    }
                  }}
                  placeholder="run / status / cancel / approve / hold / help"
                />
                <button
                  className="ghost"
                  onClick={() => {
                    handleTerminalCommand(terminalInput);
                    setTerminalInput("");
                  }}
                >
                  Execute
                </button>
              </div>
            </section>
          )}
        </main>

        <aside className="right">
          <section className="card right-card">
            <h3>Approvals & Publishing</h3>
            <div className="stack">
              <div className="mini-card">
                <h4>Quality Checklist</h4>
                <p className="mini-note">Optional pre-flight checks before publishing.</p>
                <label className="check-row"><input type="checkbox" defaultChecked /> <span>Email</span></label>
                <label className="check-row"><input type="checkbox" defaultChecked /> <span>Website</span></label>
              </div>
              <div className="mini-card">
                <h4>Schedule</h4>
                <p>{finalOutput ? "Ready to schedule" : "No package yet..."}</p>
              </div>
              <div className="mini-card">
                <h4>Approval Progress</h4>
                <p>
                  {reviewDecision
                    ? `${reviewDecision.approved ? "Approved" : "Needs changes"}${reviewDecision.forced ? " (forced loop)" : ""}`
                    : "Draft received - awaiting feedback"}
                </p>
              </div>
              <div className="mini-card">
                <h4>Approval gate</h4>
                <p>{approvalState}</p>
                <button className="primary" onClick={() => setShowApprovalModal(true)} disabled={!needsApproval}>
                  Review draft
                </button>
              </div>
              <div className="mini-card">
                <h4>Human-in-the-loop</h4>
                <p>{needsHuman ? needsHuman.message : "Automatic approval gate opening"}</p>
                <button className="primary" onClick={() => setShowApprovalModal(true)} disabled={!needsApproval}>
                  Resume Execution
                </button>
              </div>
              <div className="mini-card">
                <h4>Published packages</h4>
                {publishedHistory.length === 0 && <p>No packages yet.</p>}
                {publishedHistory.slice(0, 3).map((item, idx) => (
                  <button
                    className="published-item"
                    key={`${item.time}-${idx}`}
                    onClick={() => setSelectedPublished(item)}
                  >
                    <span>{item.name}</span>
                    <em>{item.time}</em>
                  </button>
                ))}
                {publishedHistory.length > 3 && (
                  <button className="ghost drawer-trigger" onClick={() => setShowPackagesDrawer(true)}>
                    View all packages
                  </button>
                )}
              </div>
              <div className="mini-card">
                <h4>Selected package</h4>
                {selectedPublished ? (
                  <div className="package-detail">
                    <strong>{selectedPublished.name}</strong>
                    <pre>{selectedPublished.publish_package || "No package content yet."}</pre>
                  </div>
                ) : (
                  <p>Select a package to view its contents.</p>
                )}
              </div>
            </div>
          </section>
        </aside>
      </section>

      <footer>Built with Microsoft Agent Framework and a multi-agent review loop.</footer>

      {showApprovalModal && needsApproval && (
        <div className="modal-backdrop" onClick={() => setShowApprovalModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Final approval</h3>
              <button className="ghost" onClick={() => setShowApprovalModal(false)}>Close</button>
            </div>
            <p className="modal-subtitle">{needsApproval.message}</p>
            <div className="modal-body">
              <div className="draft-preview">
                <h4>Draft to approve</h4>
                <pre>{needsApproval.draft}</pre>
              </div>
              <div className="approval-side">
                <div className="approval-history">
                  <h4>Comment history</h4>
                  {approvalHistory.length === 0 && (
                    <p className="muted">No approval notes yet.</p>
                  )}
                  {approvalHistory.map((item, idx) => (
                    <div className="history-item" key={`${item.time}-${idx}`}>
                      <span>{item.note}</span>
                      <em>{item.time}</em>
                    </div>
                  ))}
                </div>
                <div className="approval-note">
                  <label>Add note</label>
                  <textarea
                    value={approvalNote}
                    onChange={(e) => setApprovalNote(e.target.value)}
                    placeholder="Add a final approval note or conditions."
                  ></textarea>
                </div>
              </div>
            </div>
            <div className="modal-actions">
              <button className="ghost" onClick={holdApproval}>Hold</button>
              <button className="primary" onClick={approvePublish}>Approve & publish</button>
            </div>
          </div>
        </div>
      )}

      {showPackagesDrawer && (
        <div className="drawer-backdrop" onClick={() => setShowPackagesDrawer(false)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-header">
              <h3>All published packages</h3>
              <button className="ghost" onClick={() => setShowPackagesDrawer(false)}>Close</button>
            </div>
            <input
              className="drawer-search"
              placeholder="Search packages..."
              value={packageSearch}
              onChange={(e) => setPackageSearch(e.target.value)}
            />
            <div className="drawer-list">
              {filteredPackages.length === 0 && (
                <p className="muted">No matching packages.</p>
              )}
              {filteredPackages.map((item) => (
                <button
                  className="drawer-item"
                  key={item.id || item.time}
                  onClick={() => {
                    setSelectedPublished(item);
                    setShowPackagesDrawer(false);
                  }}
                >
                  <strong>{item.name}</strong>
                  <span>{item.time}</span>
                </button>
              ))}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
