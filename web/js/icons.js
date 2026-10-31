// Icons drawn in markup built here; the shapes live in icons.svg.

function icon(name, size = 16, cls = "ico") {
  return `<svg class="${cls ? cls + " " : ""}ic" width="${size}" height="${size}" aria-hidden="true"><use href="icons.svg#${name}"/></svg>`;
}

const ICON_MAIL = icon("mail");
const ICON_CHAT = icon("chat");
const ICON_UP = icon("thumb-up");
const ICON_DOWN = icon("thumb-down");
const ICON_LOCK = icon("lock", 13);
const ICON_TRASH = icon("trash");
const ICON_COPY = icon("copy", 15, "");
const ICON_DOWNLOAD = icon("download", 15, "");
const ICON_RESET = icon("reset", 15, "");
const ICON_SEND = icon("send", 16, "");
const ICON_X = icon("x", 14, "");
const WARN_ICON = icon("warn");
