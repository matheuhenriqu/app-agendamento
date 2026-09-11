/* Painel administrativo — Vanilla JS + Proxy Seguro /api/admin (Server-Side Auth) */
(function () {
  "use strict";

  // ---- Config -----------------------------------------------------------
  var SESSION_PIN_KEY = "adminAuthPin";
  var TZ = "America/Sao_Paulo";
  var currentPin = "";

  // ---- DOM --------------------------------------------------------------
  var lock = document.getElementById("lock");
  var lockForm = document.getElementById("lock-form");
  var pinInput = document.getElementById("pin");
  var lockError = document.getElementById("lock-error");
  var app = document.getElementById("app");
  var dateInput = document.getElementById("date");
  var refreshBtn = document.getElementById("refresh");
  var todayLabel = document.getElementById("today-label");
  var state = document.getElementById("state");
  var rows = document.getElementById("rows");
  var kpiTotal = document.getElementById("kpi-total");
  var kpiRevenue = document.getElementById("kpi-revenue");
  var kpiDone = document.getElementById("kpi-done");

  // ---- Helpers ----------------------------------------------------------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function todaySP() {
    var parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    var g = function (t) {
      return parts.filter(function (p) {
        return p.type === t;
      })[0].value;
    };
    return g("year") + "-" + g("month") + "-" + g("day");
  }

  function fmtTime(iso) {
    return new Intl.DateTimeFormat("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: TZ,
    }).format(new Date(iso));
  }

  function fmtMoney(v) {
    return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function waLink(phone) {
    var digits = String(phone || "").replace(/\D/g, "");
    if (digits.length <= 11) digits = "55" + digits;
    return { href: "https://wa.me/" + digits, label: String(phone || "") };
  }

  function statusClass(s) {
    s = String(s || "pendente").toLowerCase();
    if (s === "confirmado") return "st-confirmado";
    if (s === "concluido") return "st-concluido";
    if (s === "cancelado") return "st-cancelado";
    return "st-pendente";
  }

  function statusLabel(s) {
    s = String(s || "pendente").toLowerCase();
    if (s === "concluido") return "Concluído";
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function setState(msg, isError) {
    state.textContent = msg || "";
    state.className = "state" + (isError ? " error" : "");
  }

  // ---- Data via Backend Serverless Seguro (/api/admin) -------------------
  function loadDay() {
    var ymd = dateInput.value || todaySP();
    setState("Carregando agendamentos de " + ymd + "…", false);
    refreshBtn.disabled = true;

    return fetch("/api/admin?date=" + encodeURIComponent(ymd), {
      headers: {
        "x-admin-pin": currentPin,
      },
    })
      .then(function (res) {
        if (res.status === 401) {
          try { sessionStorage.removeItem(SESSION_PIN_KEY); } catch (e) {}
          currentPin = "";
          lock.hidden = false;
          app.hidden = true;
          throw new Error("Sessão expirada ou PIN incorreto. Digite novamente.");
        }
        return res.json().then(function (body) {
          if (!res.ok) throw new Error(body.error || "HTTP " + res.status);
          return body.agendamentos || [];
        });
      })
      .then(function (list) {
        render(list, ymd);
        setState(list.length ? "" : "Nenhum agendamento para " + ymd + ".", false);
      })
      .catch(function (err) {
        console.error("Erro no painel:", err);
        setState("Falha ao carregar: " + err.message, true);
      })
      .then(function () {
        refreshBtn.disabled = false;
      });
  }

  function render(list, ymd) {
    var done = 0;
    var revenue = 0;
    var html = "";

    list.forEach(function (a) {
      var st = String(a.status || "pendente").toLowerCase();
      if (st === "concluido") done += 1;
      if (st !== "cancelado") revenue += Number((a.servicos && a.servicos.preco) || 0);

      var wa = waLink(a.cliente_telefone);
      var svc = (a.servicos && a.servicos.nome) || "—";
      var price = a.servicos ? fmtMoney(a.servicos.preco) : "—";
      var isDone = st === "concluido";
      var isCancelled = st === "cancelado";

      html +=
        '<tr class="agenda-row">' +
        '<td class="cell-time" data-label="Horário"><span class="time">' +
        esc(fmtTime(a.data_hora)) +
        "</span></td>" +
        '<td class="cell-client" data-label="Cliente"><span class="client-name">' +
        esc(a.cliente_nome) +
        "</span></td>" +
        '<td class="cell-wa" data-label="WhatsApp"><a class="wa" href="' +
        esc(wa.href) +
        '" target="_blank" rel="noopener">' +
        '<span class="wa-icon">💬</span> ' +
        esc(wa.label) +
        "</a></td>" +
        '<td class="cell-svc" data-label="Serviço"><span class="svc-name">' +
        esc(svc) +
        "</span></td>" +
        '<td class="cell-price" data-label="Valor"><span class="price-val">' +
        esc(price) +
        "</span></td>" +
        '<td class="cell-status" data-label="Status"><span class="badge ' +
        statusClass(st) +
        '">' +
        esc(statusLabel(st)) +
        "</span></td>" +
        '<td class="cell-actions" data-label="Ações"><div class="actions">' +
        '<button type="button" class="btn-done" data-id="' +
        esc(a.id) +
        '" ' +
        (isDone ? "disabled" : "") +
        ">✓ Concluir</button>" +
        '<button type="button" class="btn-cancel" data-id="' +
        esc(a.id) +
        '" ' +
        (isCancelled ? "disabled" : "") +
        ">✕ Cancelar</button>" +
        "</div></td>" +
        "</tr>";
    });

    rows.innerHTML = html;
    kpiTotal.textContent = String(list.length);
    kpiRevenue.textContent = fmtMoney(revenue);
    kpiDone.textContent = String(done);
    todayLabel.textContent = "Agenda de " + ymd;
  }

  function setStatus(id, status) {
    setState("Atualizando status…", false);
    return fetch("/api/admin", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-admin-pin": currentPin,
      },
      body: JSON.stringify({ id: id, status: status }),
    })
      .then(function (res) {
        if (res.status === 401) {
          try { sessionStorage.removeItem(SESSION_PIN_KEY); } catch (e) {}
          currentPin = "";
          lock.hidden = false;
          app.hidden = true;
          throw new Error("Não autorizado.");
        }
        return res.json().then(function (body) {
          if (!res.ok) throw new Error(body.error || "HTTP " + res.status);
        });
      })
      .then(function () {
        return loadDay();
      })
      .catch(function (err) {
        console.error("Erro ao atualizar status:", err);
        setState("Falha ao atualizar: " + err.message, true);
      });
  }

  // ---- Events -----------------------------------------------------------
  rows.addEventListener("click", function (ev) {
    var btn = ev.target.closest("button[data-id]");
    if (!btn || btn.disabled) return;
    if (btn.className.indexOf("btn-done") !== -1) setStatus(btn.getAttribute("data-id"), "concluido");
    else setStatus(btn.getAttribute("data-id"), "cancelado");
  });

  dateInput.addEventListener("change", loadDay);
  refreshBtn.addEventListener("click", loadDay);

  // ---- PIN gate (Server-Side Auth) --------------------------------------
  function unlock() {
    lock.hidden = true;
    app.hidden = false;
    dateInput.value = todaySP();
    loadDay();
  }

  lockForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var pin = String(pinInput.value || "").trim();
    if (!pin) return;

    var submitBtn = lockForm.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    lockError.hidden = true;

    fetch("/api/admin", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-pin": pin,
      },
      body: JSON.stringify({ pin: pin }),
    })
      .then(function (res) {
        if (res.ok) {
          currentPin = pin;
          try {
            sessionStorage.setItem(SESSION_PIN_KEY, pin);
          } catch (e) {}
          lockError.hidden = true;
          unlock();
        } else {
          lockError.textContent = "PIN incorreto. Tente novamente.";
          lockError.hidden = false;
          pinInput.value = "";
          pinInput.focus();
        }
      })
      .catch(function (err) {
        console.error("Erro ao conectar:", err);
        lockError.textContent = "Falha de conexão com o servidor.";
        lockError.hidden = false;
      })
      .then(function () {
        submitBtn.disabled = false;
      });
  });

  // ---- Boot -------------------------------------------------------------
  try {
    currentPin = sessionStorage.getItem(SESSION_PIN_KEY) || "";
  } catch (e) {
    currentPin = "";
  }
  if (currentPin) {
    // Valida se o PIN salvo na sessão ainda é válido
    fetch("/api/admin", {
      method: "POST",
      headers: { "x-admin-pin": currentPin },
    }).then(function (res) {
      if (res.ok) {
        unlock();
      } else {
        try { sessionStorage.removeItem(SESSION_PIN_KEY); } catch (e) {}
        currentPin = "";
      }
    }).catch(function () {
      // Se offline/falha de rede, deixa formulário de PIN visível
    });
  }
})();

