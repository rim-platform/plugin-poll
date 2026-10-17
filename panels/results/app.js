// The Poll panel. The plugin frame sends its state through the host
// (panel.state_update): the poll of the open conversation and its counts. The
// panel runs the plugin's commands through the host (rim.command.execute): it
// starts a poll, votes, closes and forgets one, and asks for the results when the
// open conversation changes (conversation.changed). The host fills in which
// conversation a command runs in and confirms closing and forgetting itself. It
// renders everything as text and has no links, since following one would
// navigate the panel's frame, which closes it.
(function () {
  "use strict";

  var PLUGIN_ID = "chat.rim.poll";
  var MIN_OPTIONS = 2;
  var MAX_OPTIONS = 8;
  /** How long to wait for the host to say which conversation is open before asking anyway. */
  var CONVERSATION_WAIT_MS = 400;

  var $ = function (id) {
    return document.getElementById(id);
  };
  var els = {
    header: $("header"),
    question: $("question"),
    status: $("status"),
    notice: $("notice"),
    error: $("error"),
    options: $("options"),
    empty: $("empty"),
    footer: $("footer"),
    actions: $("actions"),
    refresh: $("refresh"),
    close: $("close"),
    forget: $("forget"),
    newPoll: $("new-poll"),
    form: $("form"),
    formQuestion: $("form-question"),
    formOptions: $("form-options"),
    addOption: $("add-option"),
    post: $("post"),
    cancel: $("cancel"),
  };

  var state = null;
  /** The open conversation's id as the host last said, `undefined` until it says. */
  var conversation;
  /** The person opened the form over a poll, to start the next one. */
  var composing = false;
  var nextRequest = 1;
  var pending = {};
  var busy = 0;

  function send(message) {
    window.parent.postMessage(message, "*");
  }

  /** Run one of the plugin's commands; a failure shows under the poll. */
  function run(verb, args, onDone) {
    var requestId = "poll-" + nextRequest++;
    pending[requestId] = function (result) {
      if (result.cancelled) return;
      showError(result.ok ? null : result.message);
      if (onDone) onDone(result);
    };
    busy++;
    renderBusy();
    send({
      type: "rim.command.execute",
      commandId: "plugin." + PLUGIN_ID + "." + verb,
      args: args || {},
      requestId: requestId,
    });
  }

  function results() {
    run("poll.results", {});
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function showError(text) {
    // The plugin's notice already says the same, so it is not shown twice.
    var shown = text && !(state && state.notice === text) ? text : null;
    els.error.hidden = !shown;
    els.error.textContent = shown || "";
  }

  function showNotice(text) {
    els.notice.hidden = !text;
    els.notice.textContent = text || "";
  }

  function renderBusy() {
    var buttons = document.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = busy > 0;
  }

  // ── The new poll form ──

  function optionInputs() {
    return els.formOptions.querySelectorAll("input");
  }

  function addOptionInput(value) {
    var row = element("div", "option-input");
    var input = element("input");
    input.type = "text";
    input.maxLength = 80;
    input.placeholder = "Option " + (optionInputs().length + 1);
    input.setAttribute("aria-label", input.placeholder);
    input.value = value || "";
    row.appendChild(input);
    var remove = element("button", "ghost", "×");
    remove.type = "button";
    remove.title = "Remove this option";
    remove.addEventListener("click", function () {
      if (optionInputs().length <= MIN_OPTIONS) return;
      row.remove();
      renderForm();
    });
    row.appendChild(remove);
    els.formOptions.appendChild(row);
    renderForm();
    return input;
  }

  function resetForm() {
    els.formQuestion.value = "";
    els.formOptions.textContent = "";
    for (var i = 0; i < MIN_OPTIONS; i++) addOptionInput("");
  }

  function renderForm() {
    var count = optionInputs().length;
    els.addOption.hidden = count >= MAX_OPTIONS;
    var removes = els.formOptions.querySelectorAll("button");
    for (var i = 0; i < removes.length; i++) removes[i].hidden = count <= MIN_OPTIONS;
  }

  function submitForm() {
    var question = els.formQuestion.value.trim();
    var options = [];
    var inputs = optionInputs();
    for (var i = 0; i < inputs.length; i++) {
      var option = inputs[i].value.trim();
      if (option) options.push(option);
    }
    if (!question) return showError("Write the question first.");
    if (options.length < MIN_OPTIONS) return showError("A poll needs at least two options.");
    for (var j = 0; j < options.length; j++) {
      if (/[|;]/.test(options[j])) return showError("An option cannot contain | or ;.");
    }
    run("poll", { question: question, options: options.join(" | ") }, function (result) {
      if (result.ok) {
        composing = false;
        resetForm();
        render();
      }
    });
  }

  // ── Rendering: textContent only ──

  function showEmpty(text) {
    els.header.hidden = true;
    els.footer.hidden = true;
    els.actions.hidden = true;
    els.form.hidden = true;
    els.options.textContent = "";
    els.empty.hidden = !text;
    els.empty.textContent = text || "";
  }

  function renderOption(poll, option, most) {
    var item = element("li", poll.myVote === option.number ? "mine" : "");
    var row = element("div", "row");
    row.appendChild(element("span", "text", option.number + ". " + option.text));
    row.appendChild(element("span", "count", String(option.votes)));
    if (poll.status === "open") {
      var mine = poll.myVote === option.number;
      var vote = element("button", mine ? "voted" : "", mine ? "Your vote" : "Vote");
      vote.type = "button";
      vote.title = mine ? "You voted for " + option.text : "Vote for " + option.text;
      vote.addEventListener("click", function () {
        if (!mine) run("vote", { choice: String(option.number) });
      });
      row.appendChild(vote);
    }
    item.appendChild(row);
    var track = element("div", "track");
    var bar = element("div", "bar");
    bar.style.width = most > 0 ? Math.round((option.votes / most) * 100) + "%" : "0%";
    track.appendChild(bar);
    item.appendChild(track);
    return item;
  }

  function render() {
    if (!state) return showEmpty("Waiting for the plugin…");
    showNotice(state.notice);
    if (!state.signedIn) return showEmpty("Sign in to use polls.");
    if (conversation === null) return showEmpty("Open a conversation to see its poll.");
    if (!state.inConversation) return showEmpty("Looking for a poll in this conversation…");

    var poll = state.poll;
    if (!poll || composing) {
      showEmpty("");
      els.form.hidden = false;
      els.cancel.hidden = !poll;
      if (optionInputs().length === 0) resetForm();
      renderBusy();
      return;
    }

    els.form.hidden = true;
    els.empty.hidden = true;
    els.header.hidden = false;
    els.question.textContent = poll.question;
    els.status.textContent = poll.status === "open" ? "open" : "closed";
    els.status.className = "status " + (poll.status === "open" ? "open" : "closed");
    var most = poll.options.reduce(function (max, option) {
      return Math.max(max, option.votes);
    }, 0);
    els.options.textContent = "";
    poll.options.forEach(function (option) {
      els.options.appendChild(renderOption(poll, option, most));
    });
    els.footer.hidden = false;
    els.footer.textContent = poll.counted
      ? poll.voters +
        (poll.voters === 1 ? " voter" : " voters") +
        ". Each person's latest vote counts; /vote <number> in the conversation counts too."
      : "The votes are not counted yet.";
    els.actions.hidden = false;
    els.close.hidden = !(poll.status === "open" && poll.mine);
    els.newPoll.hidden = poll.status === "open";
    renderBusy();
  }

  // ── Messages from the host ──

  var waitForConversation = setTimeout(function () {
    // A host that never says which conversation is open: ask about the current one once.
    if (conversation === undefined) results();
  }, CONVERSATION_WAIT_MS);

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || typeof message.type !== "string") return;
    switch (message.type) {
      case "theme.changed":
        Object.keys(message.variables || {}).forEach(function (name) {
          var value = message.variables[name];
          if (value) document.documentElement.style.setProperty(name, value);
        });
        break;
      case "panel.state_update":
        if (message.state === null) {
          state = null;
          showNotice(null);
          showError(null);
          showEmpty("The plugin stopped.");
          return;
        }
        state = message.state;
        render();
        break;
      case "conversation.changed": {
        clearTimeout(waitForConversation);
        var id = typeof message.conversationId === "string" ? message.conversationId : null;
        if (id === conversation) return;
        conversation = id;
        composing = false;
        showError(null);
        if (id !== null) results();
        render();
        break;
      }
      case "rim.command.result": {
        var done = pending[message.requestId];
        if (!done) return;
        delete pending[message.requestId];
        busy = Math.max(0, busy - 1);
        done(message);
        renderBusy();
        break;
      }
    }
  });

  // ── Input ──

  els.refresh.addEventListener("click", results);
  els.close.addEventListener("click", function () {
    run("poll.close", {});
  });
  els.forget.addEventListener("click", function () {
    run("poll.clear", {});
  });
  els.newPoll.addEventListener("click", function () {
    composing = true;
    showError(null);
    render();
    els.formQuestion.focus();
  });
  els.cancel.addEventListener("click", function () {
    composing = false;
    showError(null);
    render();
  });
  els.addOption.addEventListener("click", function () {
    addOptionInput("").focus();
  });
  els.form.addEventListener("submit", function (event) {
    event.preventDefault();
    submitForm();
  });
})();
