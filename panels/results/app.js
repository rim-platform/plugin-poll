// The Poll panel. The plugin frame sends its state through the host
// (panel.state_update): the poll of the conversation a poll command last ran
// in, and its counts. It renders everything as text and has no links, since
// following one would navigate the panel's frame, which closes it.
(function () {
  "use strict";

  var $ = function (id) {
    return document.getElementById(id);
  };
  var els = {
    header: $("header"),
    question: $("question"),
    status: $("status"),
    notice: $("notice"),
    options: $("options"),
    empty: $("empty"),
    footer: $("footer"),
  };

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function showNotice(text) {
    els.notice.hidden = !text;
    els.notice.textContent = text || "";
  }

  function showEmpty(text) {
    els.header.hidden = true;
    els.footer.hidden = true;
    els.options.textContent = "";
    els.empty.hidden = !text;
    els.empty.textContent = text || "";
  }

  function renderOption(option, most) {
    var item = element("li");
    var row = element("div", "row");
    row.appendChild(element("span", "text", option.number + ". " + option.text));
    row.appendChild(element("span", "count", String(option.votes)));
    item.appendChild(row);
    var track = element("div", "track");
    var bar = element("div", "bar");
    bar.style.width = most > 0 ? Math.round((option.votes / most) * 100) + "%" : "0%";
    track.appendChild(bar);
    item.appendChild(track);
    return item;
  }

  function render(state) {
    showNotice(state.notice);
    var poll = state.poll;
    if (!state.signedIn) return showEmpty("Sign in to use polls.");
    if (!state.inConversation) {
      return showEmpty("Run a poll command in a conversation to see its poll here.");
    }
    if (!poll) return showEmpty(state.notice ? "" : "There is no poll in this conversation.");
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
      els.options.appendChild(renderOption(option, most));
    });
    els.footer.hidden = false;
    els.footer.textContent = poll.counted
      ? poll.voters +
        (poll.voters === 1 ? " voter" : " voters") +
        ". Each person's latest vote counts."
      : "The votes are not counted yet.";
  }

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
          showNotice(null);
          showEmpty("The plugin stopped.");
          return;
        }
        render(message.state);
        break;
    }
  });
})();
