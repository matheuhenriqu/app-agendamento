/* Agendamento Online — WhatsApp Frontend (Vanilla JS + Supabase Proxy) */
(function () {
  "use strict";

  // ---- Config & Inicialização ----
  var history = []; // [{ role: 'user'|'assistant', content }]
  var servicosCache = [];

  // Double check azul de mensagem lida (✓✓)
  var CHECK_BLUE_SVG =
    '<svg class="wa-check" viewBox="0 0 16 11" width="16" height="11" fill="none">' +
    '<path d="M11.05.7a.75.75 0 0 0-1.1 0L5.34 5.31 3.55 3.52a.75.75 0 0 0-1.06 1.06l2.32 2.32c.3.3.77.3 1.06 0l5.18-5.14a.75.75 0 0 0 0-1.06z" fill="#53bdeb"/>' +
    '<path d="M15.05.7a.75.75 0 0 0-1.1 0L9.34 5.31l.8.8 4.91-4.85a.75.75 0 0 0 0-1.06z" fill="#53bdeb"/>' +
    "</svg>";

  var SEND_ICON_SVG =
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">' +
    '<path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>' +
    "</svg>";

  var MIC_ICON_SVG =
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">' +
    '<path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5-3c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>' +
    "</svg>";

  // ---- DOM ----
  var feed = document.getElementById("feed");
  var form = document.getElementById("form");
  var input = document.getElementById("input");
  var typing = document.getElementById("typing");
  var headerStatus = document.getElementById("header-status");
  var actionBtn = document.getElementById("btn-action");

  function now() {
    return new Date().toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function scrollToBottom() {
    requestAnimationFrame(function () {
      if (feed) {
        feed.scrollTo({ top: feed.scrollHeight, behavior: "smooth" });
      }
    });
  }

  function dedupeServicos(list) {
    if (!Array.isArray(list)) return [];
    var seen = {};
    return list.filter(function (s) {
      var key = String((s && s.nome) || "").toLowerCase().trim();
      if (!key || seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function addMessage(text, who) {
    if (!feed) return null;

    var div = document.createElement("div");
    div.className = "msg " + (who === "user" ? "out" : "in");

    var span = document.createElement("span");
    span.className = "msg-text";
    span.textContent = text;

    var time = document.createElement("span");
    time.className = "time";

    if (who === "user") {
      time.innerHTML = '<span class="wa-time-str">' + now() + "</span> " + CHECK_BLUE_SVG;
    } else {
      time.innerHTML = '<span class="wa-time-str">' + now() + "</span>";
    }

    div.appendChild(span);
    div.appendChild(time);
    feed.appendChild(div);
    scrollToBottom();
    return div;
  }

  function setTyping(on) {
    if (typing) {
      typing.hidden = !on;
    }
    if (headerStatus) {
      if (on) {
        headerStatus.textContent = "digitando...";
        headerStatus.classList.add("typing-active");
      } else {
        headerStatus.textContent = "online";
        headerStatus.classList.remove("typing-active");
      }
    }
    if (on) scrollToBottom();
  }

  function updateActionIcon() {
    if (!actionBtn || !input) return;
    var hasText = input.value.trim().length > 0;
    actionBtn.innerHTML = hasText ? SEND_ICON_SVG : MIC_ICON_SVG;
    actionBtn.setAttribute("aria-label", hasText ? "Enviar mensagem" : "Gravar áudio");
  }

  function loadServicos() {
    return fetch("/api/chat")
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        servicosCache = dedupeServicos(data.servicos);
        return servicosCache;
      })
      .catch(function (err) {
        console.warn("Consulta inicial via /api/chat falhou:", err);
        return [];
      });
  }

  function greeting() {
    var validos = dedupeServicos(servicosCache);
    if (validos.length) {
      var lista = validos
        .map(function (s) {
          return "• " + s.nome + " (R$ " + Number(s.preco).toFixed(2) + ")";
        })
        .join("\n");
      return "Olá! 👋 Sou o assistente virtual da barbearia.\nTemos os seguintes serviços disponíveis:\n\n" + lista + "\n\nQual serviço e horário você gostaria de agendar?";
    }
    return "Olá! 👋 Sou o assistente virtual da barbearia. Qual serviço e horário você gostaria de agendar?";
  }

  // ---- Chat via backend seguro ----
  function sendToBackend(message) {
    return fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: message, history: history.slice(-20) }),
    }).then(
      function (res) {
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (data) {
            if (!res.ok) {
              console.error("Erro retornado pela API:", { status: res.status, body: data });
              throw new Error(data.error || data.details || "HTTP " + res.status);
            }
            if (!data.reply) {
              console.error("Erro retornado pela API:", { status: res.status, body: data });
              throw new Error("Resposta vazia do servidor.");
            }
            return data.reply;
          });
      },
      function (networkErr) {
        console.error("Erro retornado pela API:", networkErr);
        throw new Error("Falha de rede. Verifique sua conexão.");
      }
    );
  }

  function submitText(text) {
    text = String(text || "").trim();
    if (!text || (actionBtn && actionBtn.disabled)) return;

    addMessage(text, "user");
    history.push({ role: "user", content: text });
    if (input) {
      input.value = "";
      input.focus();
    }
    updateActionIcon();

    if (actionBtn) actionBtn.disabled = true;
    setTyping(true);

    sendToBackend(text)
      .then(function (reply) {
        setTyping(false);
        addMessage(reply || "Pode me dar mais detalhes?", "bot");
        history.push({ role: "assistant", content: reply });
      })
      .catch(function (err) {
        setTyping(false);
        console.error("Erro retornado pela API:", err);
        addMessage("⚠️ " + (err.message || "Falha de conexão. Tente de novo em instantes."), "bot");
      })
      .then(function () {
        if (actionBtn) actionBtn.disabled = false;
      });
  }

  // ---- Event Listeners ----
  if (form) {
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var val = input ? input.value.trim() : "";
      if (val) {
        submitText(val);
      } else {
        if (input) input.focus();
      }
    });
  }

  if (input) {
    input.addEventListener("input", updateActionIcon);
  }

  // Chips de ação rápida: enviam a mensagem clicada
  Array.prototype.forEach.call(document.querySelectorAll(".chip"), function (chip) {
    chip.addEventListener("click", function () {
      submitText(chip.getAttribute("data-msg") || chip.textContent);
    });
  });

  // Botão voltar (recarrega/limpa o chat caso o usuário clique)
  var backBtn = document.querySelector(".back-btn");
  if (backBtn) {
    backBtn.addEventListener("click", function () {
      if (confirm("Deseja reiniciar esta conversa?")) {
        window.location.reload();
      }
    });
  }

  // ---- Boot ----
  updateActionIcon();
  loadServicos().then(function () {
    addMessage(greeting(), "bot");
    history.push({ role: "assistant", content: greeting() });
  });
})();
