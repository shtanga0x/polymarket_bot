export function langKeyboard(txt) {
  return { inline_keyboard: [[
    { text: txt.btnEn, callback_data: 'lang_en' },
    { text: txt.btnRu, callback_data: 'lang_ru' },
  ]]};
}

export function subKeyboard(txt) {
  return { inline_keyboard: [
    [{ text: txt.btnFollow, url: 'https://t.me/shtanga0x' }],
    [{ text: txt.btnCheck,  callback_data: 'check_sub'    }],
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

export function dashboardsKeyboard(txt) {
  return { inline_keyboard: [[
    { text: txt.btnCoreDashboard,  url: 'https://shtanga0x.github.io/polymarket_core/'  },
    { text: txt.btnWatchDashboard, url: 'https://shtanga0x.github.io/polymarket_watch/' },
  ]]};
}

export function settingsKeyboard(txt, active) {
  return { inline_keyboard: [
    [{ text: txt.btnChange,                               callback_data: 'change_settings' }],
    [{ text: active ? txt.btnStop : txt.btnResume,        callback_data: active ? 'toggle_off' : 'toggle_on' }],
  ]};
}
