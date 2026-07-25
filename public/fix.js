const fs = require('fs');
let html = fs.readFileSync('public/index.html', 'utf8');

const oldApi = `var Api = {
  call: function(fnName, args, onOk, onErr) {
    if (!GS) { if (onErr) onErr(new Error('preview')); return; }
    try {
      var runner = google.script.run
        .withSuccessHandler(function(res) { if (onOk) onOk(res); })
        .withFailureHandler(function(err) {
          console.log('[API ERROR] ' + fnName, err);
          if (onErr) onErr(err);
        });
      runner[fnName].apply(runner, args || []);
    } catch(e) {
      console.log('[API THROW] ' + fnName, e);
      if (onErr) onErr(e);
    }
  },
  /** 결과를 신경 안 쓰는 호출 (fire & forget) */
  fire: function(fnName, args) {
    if (!GS) return;
    try {
      var r = google.script.run;
      r[fnName].apply(r, args || []);
    } catch(e) {}
  }
};`;

const newApi = `var Api = {
  call: function(fnName, args, onOk, onErr) {
    var urlMap = {
      'searchAndSave':'/api/search','getRealTimeProducts':'/api/search',
      'searchAliOnly':'/api/search','getInitData':'/api/init',
      'getDailyRecommendations':'/api/rec','getMoreOfKeyword':'/api/rec',
      'getPriceHistory':'/api/history','getHistoryBatch':'/api/history-batch',
      'askAI':'/api/ai','saveAlert':'/api/alerts','getMyAlerts':'/api/alerts',
      'deleteAlert':'/api/alerts','saveUserData':'/api/sync','loadUserData':'/api/sync',
      'saveUserProfile':'/api/profile','loadUserProfile':'/api/profile',
      'getPopularKeywords':'/api/init','getProfileRecommendations':'/api/rec',
      'saveRecommendedProducts':null,'getMonthlyRecommendations':'/api/init',
      'getPriceDropTop':'/api/init','recordSearchStat_':'/api/stats'
    };
    var url = urlMap[fnName];
    if (url === null) { if (onOk) onOk({ ok: true }); return; }
    if (!url) { if (onErr) onErr(new Error('unknown fn: ' + fnName)); return; }
    var method = 'GET';
    var fetchOpts = { headers: { 'Content-Type': 'application/json' } };
    var queryUrl = url;
    if (fnName === 'searchAndSave' || fnName === 'getRealTimeProducts' || fnName === 'searchAliOnly') {
      queryUrl = url + '?keyword=' + encodeURIComponent(args[0] || '');
    } else if (fnName === 'getPriceHistory') {
      queryUrl = url + '?title=' + encodeURIComponent(args[0] || '');
    } else if (fnName === 'getHistoryBatch') {
      queryUrl = url + '?titles=' + encodeURIComponent(JSON.stringify(args[0] || []));
    } else if (fnName === 'getMyAlerts') {
      queryUrl = url + '?email=' + encodeURIComponent(args[0] || '');
    } else if (fnName === 'loadUserData') {
      queryUrl = url + '?email=' + encodeURIComponent(args[0] || '');
    } else if (fnName === 'loadUserProfile') {
      queryUrl = url + '?email=' + encodeURIComponent(args[0] || '');
    } else if (fnName === 'getDailyRecommendations' || fnName === 'getMoreOfKeyword') {
      queryUrl = url + '?keyword=' + encodeURIComponent(args[0] || '');
    } else if (fnName === 'getProfileRecommendations') {
      queryUrl = url + '?cats=' + encodeURIComponent(JSON.stringify(args[0] || []));
    } else if (fnName === 'askAI') {
      method = 'POST';
      fetchOpts.body = JSON.stringify({ question: args[0], contextProducts: args[1], chatHistory: args[2], profile: args[3] });
    } else if (fnName === 'saveAlert') {
      method = 'POST';
      fetchOpts.body = JSON.stringify({ email: args[0], title: args[1], targetPrice: args[2], currentPrice: args[3], link: args[4], image: args[5], mall: args[6] });
    } else if (fnName === 'deleteAlert') {
      method = 'DELETE';
      fetchOpts.body = JSON.stringify({ email: args[0], title: args[1] });
    } else if (fnName === 'saveUserData') {
      method = 'POST';
      queryUrl = url + '?email=' + encodeURIComponent(args[0] || '');
      try { var d = JSON.parse(args[1]); fetchOpts.body = JSON.stringify(d); } catch(e) { fetchOpts.body = args[1]; }
    } else if (fnName === 'saveUserProfile') {
      method = 'POST';
      queryUrl = url + '?email=' + encodeURIComponent(args[0] || '');
      fetchOpts.body = JSON.stringify(args[1] || {});
    } else if (fnName === 'recordSearchStat_') {
      queryUrl = url + '?keyword=' + encodeURIComponent(args[0] || '');
    }
    fetchOpts.method = method;
    fetch(queryUrl, fetchOpts)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (fnName === 'getInitData') { if (onOk) onOk(data); }
        else if (fnName === 'getPopularKeywords') { if (onOk) onOk(data.popular || data || []); }
        else if (fnName === 'getMonthlyRecommendations') { if (onOk) onOk(data.monthly || data); }
        else if (fnName === 'getPriceDropTop') { if (onOk) onOk(data.priceDrop || data || []); }
        else if (fnName === 'getDailyRecommendations' || fnName === 'getMoreOfKeyword') { if (onOk) onOk(data); }
        else if (fnName === 'loadUserData') { if (onOk) onOk({ success: data.success, data: JSON.stringify(data.data || {}) }); }
        else { if (onOk) onOk(data); }
      })
      .catch(function(e) { if (onErr) onErr(e); });
  },
  fire: function(fnName, args) { Api.call(fnName, args); }
};`;

if (!html.includes(oldApi)) {
  console.log('정확한 매칭 실패 - 강제 교체 시도');
  const idx = html.indexOf('var Api = {');
  const endIdx = html.indexOf('\n};', idx) + 3;
  html = html.substring(0, idx) + newApi + html.substring(endIdx);
} else {
  html = html.replace(oldApi, newApi);
}

fs.writeFileSync('public/index.html', html);
console.log('완료!');