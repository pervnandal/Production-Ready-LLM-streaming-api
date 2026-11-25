const apiKeyInput = document.getElementById("apiKey");
const rememberKeyCheckbox = document.getElementById("rememberKey");
const toggleKeyBtn = document.getElementById("toggleKeyBtn");
const temperatureInput = document.getElementById("temperature");
const tempValue = document.getElementById("tempValue");
const reuseIdempotencyCheckbox = document.getElementById("reuseIdempotency");
const messageInput = document.getElementById("message");
const charCount = document.getElementById("charCount");

const streamButton = document.getElementById("streamButton");
const normalButton = document.getElementById("normalButton");
const stopButton = document.getElementById("stopButton");
const clearButton = document.getElementById("clearButton");
const copyButton = document.getElementById("copyButton");

const output = document.getElementById("output");
const outputBody = output.parentElement;
const statusBadge = document.getElementById("status");
const errorBanner = document.getElementById("errorBanner");

const healthPill = document.getElementById("healthPill");
const healthText = document.getElementById("healthText");
const modelTag = document.getElementById("modelTag");
const metaMode = document.getElementById("metaMode");
const metaModel = document.getElementById("metaModel");
const metaCached = document.getElementById("metaCached");
const metaLatency = document.getElementById("metaLatency");

let activeController = null;
let lastIdempotencyKey = null;
let rawOutputText = "";
let renderQueued = false;

// --------------------------------------------------
// INITIALIZATION
// --------------------------------------------------
const savedKey = sessionStorage.getItem("llm_api_key");
if (savedKey) {
    apiKeyInput.value = savedKey;
}

apiKeyInput.addEventListener("input", () => {
    if (rememberKeyCheckbox.checked) {
        sessionStorage.setItem("llm_api_key", apiKeyInput.value.trim());
    }
});

rememberKeyCheckbox.addEventListener("change", () => {
    if (rememberKeyCheckbox.checked) {
        sessionStorage.setItem("llm_api_key", apiKeyInput.value.trim());
    } else {
        sessionStorage.removeItem("llm_api_key");
    }
});

toggleKeyBtn.addEventListener("click", () => {
    const isPassword = apiKeyInput.type === "password";
    apiKeyInput.type = isPassword ? "text" : "password";
    toggleKeyBtn.textContent = isPassword ? "Hide" : "Show";
});

temperatureInput.addEventListener("input", () => {
    tempValue.textContent = Number(temperatureInput.value).toFixed(1);
});

messageInput.addEventListener("input", updateCharCount);

messageInput.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !streamButton.disabled) {
        event.preventDefault();
        runStreamRequest();
    }
});

document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
        messageInput.value = chip.dataset.prompt || "";
        updateCharCount();
        messageInput.focus();
    });
});

checkHealth();

// --------------------------------------------------
// MARKDOWN RENDERING
// --------------------------------------------------
function renderMarkdown(markdownText, autoScroll = false) {
    if (!markdownText) {
        output.innerHTML = "";
        return;
    }

    if (typeof window.marked !== "undefined") {
        const parsedHtml = window.marked.parse(markdownText, {
            gfm: true,
            breaks: true,
        });
        const safeHtml =
            typeof window.DOMPurify !== "undefined"
                ? window.DOMPurify.sanitize(parsedHtml)
                : parsedHtml;

        output.innerHTML = safeHtml;

        // Wrap tables so wide comparisons scroll horizontally cleanly
        output.querySelectorAll("table").forEach((table) => {
            if (!table.parentElement.classList.contains("table-wrap")) {
                const wrapper = document.createElement("div");
                wrapper.className = "table-wrap";
                table.parentNode.insertBefore(wrapper, table);
                wrapper.appendChild(table);
            }
        });
    } else {
        // Offline fallback if CDN scripts fail to load
        output.style.whiteSpace = "pre-wrap";
        output.textContent = markdownText;
    }

    if (autoScroll) {
        outputBody.scrollTop = outputBody.scrollHeight;
    }
}

function scheduleStreamRender() {
    if (renderQueued) return;
    renderQueued = true;

    requestAnimationFrame(() => {
        renderQueued = false;
        renderMarkdown(rawOutputText, true);
    });
}

// --------------------------------------------------
// UI HELPERS
// --------------------------------------------------
function updateCharCount() {
    charCount.textContent = `${messageInput.value.length} / 2000`;
}

function setStatus(label, variant) {
    statusBadge.textContent = label;
    statusBadge.className = `status-badge status-${variant}`;
}

function setBusy(isBusy) {
    streamButton.disabled = isBusy;
    normalButton.disabled = isBusy;
    stopButton.hidden = !isBusy;
}

function showError(message) {
    errorBanner.textContent = message;
    errorBanner.hidden = false;
    setStatus("Error", "error");
}

function clearError() {
    errorBanner.textContent = "";
    errorBanner.hidden = true;
}

function resetOutput(placeholder = "") {
    rawOutputText = "";
    output.style.whiteSpace = "";
    output.textContent = placeholder;
    output.classList.toggle("is-empty", placeholder === "Your response will appear here...");
    output.classList.remove("is-streaming");
    copyButton.disabled = true;
}

function validateInputs() {
    clearError();
    const message = messageInput.value.trim();
    const apiKey = apiKeyInput.value.trim();

    if (!apiKey) {
        showError("Please enter your X-API-KEY before sending a request.");
        apiKeyInput.focus();
        return null;
    }

    if (!message) {
        showError("Please enter a prompt.");
        messageInput.focus();
        return null;
    }

    return {
        message,
        apiKey,
        temperature: Number(temperatureInput.value),
    };
}

async function checkHealth() {
    try {
        const res = await fetch("/health");
        if (!res.ok) throw new Error("Unhealthy");
        const data = await res.json();
        healthPill.classList.add("healthy");
        healthText.textContent = `Healthy (${data.environment})`;
        if (data.model) {
            modelTag.textContent = data.model;
            metaModel.textContent = data.model;
        }
    } catch {
        healthPill.classList.add("unhealthy");
        healthText.textContent = "API Unreachable";
    }
}

async function extractErrorDetail(response, fallback) {
    try {
        const data = await response.json();
        if (typeof data.detail === "string") return data.detail;
        if (Array.isArray(data.detail)) {
            return data.detail.map((item) => item.msg).join("; ");
        }
        return fallback;
    } catch {
        return `${fallback} (HTTP ${response.status})`;
    }
}

// --------------------------------------------------
// NORMAL REQUEST (/v1/chat)
// --------------------------------------------------
async function runNormalRequest() {
    const payload = validateInputs();
    if (!payload) return;

    activeController = new AbortController();
    const startedAt = performance.now();

    const idempotencyKey =
        reuseIdempotencyCheckbox.checked && lastIdempotencyKey
            ? lastIdempotencyKey
            : `web-${Date.now()}`;
    lastIdempotencyKey = idempotencyKey;

    setBusy(true);
    setStatus("Loading...", "busy");
    resetOutput("Waiting for model response...");
    output.classList.add("is-empty");
    metaMode.textContent = "Normal";
    metaCached.textContent = "—";
    metaLatency.textContent = "—";

    try {
        const response = await fetch("/v1/chat", {
            method: "POST",
            signal: activeController.signal,
            headers: {
                "Content-Type": "application/json",
                "X-API-KEY": payload.apiKey,
                "Idempotency-Key": idempotencyKey,
            },
            body: JSON.stringify({
                message: payload.message,
                temperature: payload.temperature,
            }),
        });

        if (!response.ok) {
            const detail = await extractErrorDetail(response, "Normal request failed");
            throw new Error(detail);
        }

        const data = await response.json();
        const elapsed = ((performance.now() - startedAt) / 1000).toFixed(2);
        const isCached = data.cached ?? data.cache ?? false;

        rawOutputText = data.answer || "";
        output.classList.remove("is-empty");
        renderMarkdown(rawOutputText, false);
        outputBody.scrollTop = 0;
        copyButton.disabled = !rawOutputText.trim();

        metaModel.textContent = data.model || metaModel.textContent;
        metaCached.textContent = isCached ? "Yes (Idempotent)" : "No";
        metaLatency.textContent = `${elapsed}s`;
        setStatus("Completed", "ok");
    } catch (error) {
        if (error.name === "AbortError") {
            setStatus("Stopped", "ready");
        } else {
            resetOutput("Your response will appear here...");
            showError(error.message);
        }
    } finally {
        activeController = null;
        setBusy(false);
    }
}

// --------------------------------------------------
// STREAMING REQUEST (/v1/chat/stream)
// --------------------------------------------------
function parseSseBlock(rawBlock) {
    let eventName = "message";
    const dataLines = [];

    for (const line of rawBlock.split("\n")) {
        if (line.startsWith("event:")) {
            eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
            dataLines.push(line.startsWith("data: ") ? line.slice(6) : line.slice(5));
        }
    }

    return { eventName, data: dataLines.join("\n") };
}

async function runStreamRequest() {
    const payload = validateInputs();
    if (!payload) return;

    activeController = new AbortController();
    const startedAt = performance.now();

    setBusy(true);
    setStatus("Streaming...", "busy");
    resetOutput("");
    output.classList.remove("is-empty");
    output.classList.add("is-streaming");
    metaMode.textContent = "SSE Stream";
    metaCached.textContent = "N/A";
    metaLatency.textContent = "—";

    try {
        const response = await fetch("/v1/chat/stream", {
            method: "POST",
            signal: activeController.signal,
            headers: {
                "Content-Type": "application/json",
                "X-API-KEY": payload.apiKey,
            },
            body: JSON.stringify({
                message: payload.message,
                temperature: payload.temperature,
            }),
        });

        if (!response.ok) {
            const detail = await extractErrorDetail(response, "Streaming request failed");
            throw new Error(detail);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let streamErrored = false;

        const processBlock = (block) => {
            if (!block.trim()) return;
            const { eventName, data } = parseSseBlock(block);

            if (eventName === "error") {
                streamErrored = true;
                showError(data || "An error occurred while streaming.");
                return;
            }

            if (eventName === "done") {
                return;
            }

            rawOutputText += data;
            scheduleStreamRender();
        };

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

            const blocks = buffer.split("\n\n");
            buffer = blocks.pop();

            for (const block of blocks) {
                processBlock(block);
            }
        }

        if (buffer.trim()) {
            processBlock(buffer);
        }

        // Final synchronous render so the last chunk is guaranteed to display
        renderMarkdown(rawOutputText, true);

        const elapsed = ((performance.now() - startedAt) / 1000).toFixed(2);
        metaLatency.textContent = `${elapsed}s`;
        copyButton.disabled = !rawOutputText.trim();

        if (!streamErrored) {
            setStatus("Completed", "ok");
        }
    } catch (error) {
        if (error.name === "AbortError") {
            renderMarkdown(rawOutputText, false);
            setStatus("Stopped", "ready");
            copyButton.disabled = !rawOutputText.trim();
        } else {
            showError(error.message);
        }
    } finally {
        output.classList.remove("is-streaming");
        activeController = null;
        setBusy(false);
    }
}

// --------------------------------------------------
// BUTTON LISTENERS
// --------------------------------------------------
streamButton.addEventListener("click", runStreamRequest);
normalButton.addEventListener("click", runNormalRequest);

stopButton.addEventListener("click", () => {
    if (activeController) {
        activeController.abort();
    }
});

clearButton.addEventListener("click", () => {
    clearError();
    messageInput.value = "";
    updateCharCount();
    resetOutput("Your response will appear here...");
    setStatus("Ready", "ready");
    metaMode.textContent = "—";
    metaCached.textContent = "—";
    metaLatency.textContent = "—";
});

copyButton.addEventListener("click", async () => {
    if (!rawOutputText) return;
    await navigator.clipboard.writeText(rawOutputText);
    const original = copyButton.textContent;
    copyButton.textContent = "Copied!";
    setTimeout(() => {
        copyButton.textContent = original;
    }, 1500);
});