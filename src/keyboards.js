export function langKeyboard(txt) {
  return { inline_keyboard: [[
    { text: txt.btnEn, callback_data: 'lang_en' },
    { text: txt.btnRu, callback_data: 'lang_ru' },
  ]]};
}

// Closed group: no invite link is shown — membership is granted by the manager,
// the bot only verifies it.
export function subKeyboard(txt) {
  return { inline_keyboard: [
    [{ text: txt.btnCheck, callback_data: 'check_sub' }],
  ]};
}

export function noSubKeyboard(txt) {
  return { inline_keyboard: [
    [{ text: txt.btnManager,  url: 'https://t.me/shtanga0xc' }],
    [{ text: txt.btnTryAgain, callback_data: 'check_sub'     }],
  ]};
}

export function portfolioKeyboard(txt) {
  return { inline_keyboard: [
    [{ text: txt.btnCore,  callback_data: 'port_core'  },
     { text: txt.btnWatch, callback_data: 'port_watch' }],
    [{ text: txt.btnBoth,  callback_data: 'port_both'  }],
  ]};
}

export function topKeyboard(txt) {
  return { inline_keyboard: [[
    { text: txt.btnTop5,  callback_data: 'top_5'  },
    { text: txt.btnTop10, callback_data: 'top_10' },
    { text: txt.btnTop30, callback_data: 'top_30' },
  ]]};
}

// All dashboard access lives in @shtanga_gate_bot now. This bot no longer mints
// links; its dashboard button just sends the user to the access hub.
const GATE_BOT = 'https://t.me/shtanga_gate_bot';

export function openDashboardKeyboard(txt) {
  return { inline_keyboard: [[{ text: txt.btnOpenDashboard, url: GATE_BOT }]] };
}

export function settingsKeyboard(txt, active) {
  return { inline_keyboard: [
    [{ text: txt.btnOpenDashboard,                        url: GATE_BOT }],
    [{ text: txt.btnChange,                               callback_data: 'change_settings' }],
    [{ text: active ? txt.btnStop : txt.btnResume,        callback_data: active ? 'toggle_off' : 'toggle_on' }],
  ]};
}
