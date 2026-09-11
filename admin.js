/* Painel administrativo — Vanilla JS + Supabase REST (anon key) */
(function () {
  "use strict";

  // ---- Config -----------------------------------------------------------
  var SUPABASE_URL = "https://muflldkxijpbwklbojto.supabase.co";
  var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im11ZmxsZGt4aWpwYndrbGJvanRvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwNzg0MjIsImV4cCI6MjEwNDY1NDQyMn0.oFkPVg7uUG724jVzlWp6DFwT4rK-QYkoy73r-qzEa0A";
  // TROQUE o PIN antes de publicar. Gate simples contra curiosos
  // (não é segurança real: o código-fonte é visível no navegador).
  var ADMIN_PIN = "1234";
  var SESSION_KEY = "adminAuth";
  var TZ = "America/Sao_Paulo";

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

  function dayRange(ymd) {
    var d = new Date(ymd + "T12:00:00-03:00");
    var next = new Date(d);
    next.setDate(d.getDate() + 1);
    var fmt = function (x) {
      var m = String(x.getMonth() + 1);
      var day = String(x.getDate());
      return x.getFullYear() + "-" + (m.length < 2 ? "0" + m : m) + "-" + (day.length < 2 ? "0" + day : day);
    };
    return { start: fmt(d) + "T00:00:00-03:00", end: fmt(next) + "T00:00:00-03:00" };
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

  function sbHeaders() {
    return {
      apikey: SUPABASE_ANON_KEY,
      authorization: "Bearer " + SUPABASE_ANON_KEY,
      "content-type": "application/json",
      prefer: "return=representation",
    };
  }

  // ---- Data -------------------------------------------------------------
  function loadDay() {
    var ymd = dateInput.value || todaySP();
    var range = dayRange(ymd);
    setState("Carregando agendamentos de " + ymd + "…", false);
    refreshBtn.disabled = true;

    var url =
      SUPABASE_URL +
      "/rest/v1/agendamentos?data_hora=gte." +
      encodeURIComponent(range.start) +
      "&data_hora=lt." +
      encodeURIComponent(range.end) +
      "&select=*,servicos(nome,preco)&order=data_hora.asc";

    return fetch(url, { headers: sbHeaders() })
      .then(function (res) {
        return res.text().then(function (body) {
          var data = {};
          try {
            data = JSON.parse(body);
          } catch (e) {
            data = { raw: body };
          }
          if (!res.ok) throw new Error("HTTP " + res.status + ": " + body.slice(0, 200));
          return Array.isArray(data) ? data : [];
        });
      })
      .then(function (list) {
        render(list, ymd);
        setState(list.length ? "" : "Nenhum agendamento para " + ymd + ".", false);
      })
      .catch(function (err) {
        console.error("Erro retornado pela API:", err);
        setState("Falha ao carregar: " + err.message + " (verifique RLS no Supabase).", true);
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
        "<tr>" +
        '<td class="time">' +
        esc(fmtTime(a.data_hora)) +
        "</td>" +
        "<td>" +
        esc(a.cliente_nome) +
        "</td>" +
        '<td><a class="wa" href="' +
        esc(wa.href) +
        '" target="_blank" rel="noopener">💬 ' +
        esc(wa.label) +
        "</a></td>" +
        "<td>" +
        esc(svc) +
        "</td>" +
        "<td>" +
        esc(price) +
        "</td>" +
        '<td><span class="badge ' +
        statusClass(st) +
        '">' +
        esc(statusLabel(st)) +
        "</span></td>" +
        '<td><div class="actions">' +
        '<button type="button" class="btn-done" data-id="' +
        esc(a.id) +
        '" ' +
        (isDone ? "disabled" : "") +
        ">Concluir</button>" +
        '<button type="button" class="btn-cancel" data-id="' +
        esc(a.id) +
        '" ' +
        (isCancelled ? "disabled" : "") +
        ">Cancelar</button>" +
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
    return fetch(SUPABASE_URL + "/rest/v1/agendamentos?id=eq." + encodeURIComponent(id), {
      method: "PATCH",
      headers: sbHeaders(),
      body: JSON.stringify({ status: status }),
    })
      .then(function (res) {
        return res.text().then(function (body) {
          if (!res.ok) throw new Error("HTTP " + res.status + ": " + body.slice(0, 200));
        });
      })
      .then(function () {
        return loadDay();
      })
      .catch(function (err) {
        console.error("Erro retornado pela API:", err);
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

  // ---- PIN gate ---------------------------------------------------------
  function unlock() {
    lock.hidden = true;
    app.hidden = false;
    dateInput.value = todaySP();
    loadDay();
  }

  lockForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (pinInput.value === ADMIN_PIN) {
      try {
        sessionStorage.setItem(SESSION_KEY, "1");
      } catch (e) {
        /* sessionStorage indisponível: segue sem persistir */
      }
      lockError.hidden = true;
      unlock();
    } else {
      lockError.hidden = false;
      pinInput.value = "";
      pinInput.focus();
    }
  });

  // ---- Boot -------------------------------------------------------------
  var authed = false;
  try {
    authed = sessionStorage.getItem(SESSION_KEY) === "1";
  } catch (e) {
    authed = false;
  }
  if (authed) unlock();
})();
