/* Agendamento Online — Vanilla JS + Supabase + proxy /api/chat */
(function () {
  "use strict";

  // ---- Config & Inicialização ----
  // Obtém catálogo via /api/chat (servidor Edge) para desacoplar chaves do cliente
  var history = []; // [{ role: 'user'|'assistant', content }]
  var servicosCache = [];

  // ---- DOM ----
  var feed = document.getElementById("feed");
  var form = document.getElementById("form");
  var input = document.getElementById("input");
  var typing = document.getElementById("typing");
  var sendBtn = form ? form.querySelector("button[type=submit]") : null;

  function now() {
    return new Date().toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function scrollToBottom() {
    requestAnimationFrame(function () {
      feed.scrollTo({ top: feed.scrollHeight, behavior: "smooth" });
    });
  }

  function addMessage(text, who) {
    var div = document.createElement("div");
    div.className = "msg " + (who === "user" ? "out" : "in");
    var span = document.createElement("span");
    span.textContent = text;
    var time = document.createElement("span");
    time.className = "time";
    time.textContent = now();
    div.appendChild(span);
    div.appendChild(time);
    feed.appendChild(div);
    scrollToBottom();
    return div;
  }

  function setTyping(on) {
    if (!typing) return;
    typing.hidden = !on;
    if (on) scrollToBottom();
  }

  function loadServicos() {
    return fetch("/api/chat")
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        servicosCache = Array.isArray(data.servicos) ? data.servicos : [];
        return servicosCache;
      })
      .catch(function (err) {
        console.warn("Consulta direta via /api/chat falhou:", err);
        return [];
      });
  }

  function greeting() {
    if (servicosCache.length) {
      var lista = servicosCache
        .map(function (s) {
          return "• " + s.nome + " (R$ " + Number(s.preco).toFixed(2) + ")";
        })
        .join("\n");
      return "Olá! 👋 Sou a assistente de agendamento. Temos:\n" + lista + "\nQual serviço e horário prefere?";
    }
    return "Olá! 👋 Sou a assistente de agendamento. Qual serviço e horário prefere?";
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
    if (!text || sendBtn.disabled) return;

    addMessage(text, "user");
    history.push({ role: "user", content: text });
    input.value = "";
    input.focus();
    sendBtn.disabled = true;
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
        sendBtn.disabled = false;
      });
  }

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    submitText(input.value);
  });

  // Chips de ação rápida: enviam a mensagem como se digitada.
  Array.prototype.forEach.call(document.querySelectorAll(".chip"), function (chip) {
    chip.addEventListener("click", function () {
      submitText(chip.getAttribute("data-msg") || chip.textContent);
    });
  });

  // ---- Boot ----
  loadServicos().then(function () {
    addMessage(greeting(), "bot");
    history.push({ role: "assistant", content: greeting() });
  });
})();
