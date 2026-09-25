/* HDRezka for Lampa MX, v1.0.4. ES5, no external browser dependencies. */
(function () {
    'use strict';
    if (window.lampaHdrezkaLoaded) return;
    window.lampaHdrezkaLoaded = true;

    var defaultServer = /* SERVER_DEFAULT */ '';
    // The companion server injects its URL here. A static host (GitHub Pages)
    // serves only this file; its origin must never be used as the API endpoint.
    var started = false;
    var activeFlow = null;
    var version = '1.0.4';
    var icon = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';

    function escape(value) {
        return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function endpoint() {
        var value = String(Lampa.Storage.get('hdrezka_server', defaultServer) || defaultServer).replace(/\/+$/, '').trim();
        if (!/^https?:\/\/[^\s/?#]+$/i.test(value) || value.indexOf('@') !== -1) throw new Error('Вкажіть адресу сервера в Налаштування → HDRezka.');
        return value;
    }

    function request(route, params, success, failure, progress) {
        function stage(message) {
            try { if (progress) progress(message); } catch (error) {}
        }
        var base;
        try { base = endpoint(); } catch (error) { failure(error.message); return null; }
        var query = Object.keys(params).map(function (key) { return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]); }).join('&');
        var url = base + '/api/' + route + (query ? '?' + query : '');
        var key = String(Lampa.Storage.get('hdrezka_key', '') || '');
        var finished = false;
        var network;
        var xhr;
        var direct = false;
        var nativeError = '';
        var timeout = route === 'health' ? 15000 : 45000;
        var timer;

        function detail(error, fallback) {
            var status = error && Number(error.status) || 0;
            var text = String(error && (error.statusText || error.name || error.type) || fallback || 'error');
            if (key) text = text.split(key).join('[key]');
            return status + ' / ' + text.replace(/[\r\n]/g, ' ').slice(0, 60);
        }
        function networkFailure(error, fallback) {
            fail('Немає з’єднання. ' + (nativeError ? 'Lampa: ' + nativeError + '; ' : '') + 'XHR: ' + detail(error, fallback));
        }

        function stop() {
            try { if (network) network.clear(); } catch (error) {}
            try { if (xhr) xhr.abort(); } catch (error) {}
        }
        function fail(message) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            // Display and save the result before cleanup in the device bridge.
            try { failure(message); } finally { stop(); }
        }
        function receive(data, status) {
            if (finished) return;
            if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch (error) { fail('Сервер повернув некоректну відповідь. Перевірте адресу сервера.'); return; }
            }
            if (!data || typeof data !== 'object') { fail('Сервер повернув некоректну відповідь.'); return; }
            if (status < 200 || status >= 300 || data.error) {
                fail(data.error && data.error.message || 'Помилка сервера: HTTP ' + status);
                return;
            }
            finished = true;
            clearTimeout(timer);
            success(data, base);
        }
        function expired() { fail('Сервер не відповів за ' + timeout / 1000 + ' с.' + (nativeError ? ' Lampa: ' + nativeError + '; XHR: timeout.' : ' Перевірте підключення в Налаштування → HDRezka.')); }
        function sendDirect() {
            if (finished || direct) return;
            direct = true;
            stage('Резервний XHR: підготовка' + (nativeError ? ' (Lampa: ' + nativeError + ')' : ''));
            try { if (network) network.clear(); } catch (error) {}
            try {
                xhr = new XMLHttpRequest();
                stage('XHR: відкриття HTTPS/HTTP-запиту');
                xhr.open('GET', url, true);
                xhr.timeout = timeout;
                if (key) xhr.setRequestHeader('X-API-Key', key);
                xhr.onload = function () {
                    if (Number(xhr.status) > 0) receive(xhr.responseText, Number(xhr.status));
                    else networkFailure(xhr, 'load');
                };
                xhr.onreadystatechange = function () {
                    if (!finished) stage('XHR: стан ' + xhr.readyState + ', HTTP ' + (Number(xhr.status) || 0));
                    if (xhr.readyState === 4 && Number(xhr.status) > 0) receive(xhr.responseText, Number(xhr.status));
                };
                xhr.onerror = function () { networkFailure(xhr, 'error'); };
                xhr.ontimeout = expired;
                stage('XHR: надсилання запиту');
                xhr.send();
                if (!finished) stage('XHR: очікування відповіді');
            } catch (error) {
                if (finished) throw error;
                networkFailure(error);
            }
        }
        // Some TV transports omit timeout/load events. Keep our own deadline
        // and prefer Lampa's transport, which the device shell can adapt.
        timer = setTimeout(expired, timeout);
        try {
            if (typeof Lampa.Reguest === 'function') {
                stage('Lampa: підготовка запиту');
                network = new Lampa.Reguest();
                network.timeout(timeout);
                stage('Lampa: надсилання запиту');
                network.native(url, function (data) { if (!direct) receive(data, 200); }, function (error) {
                    if (finished || direct) return;
                    var data = error && (error.responseJSON || error.responseText);
                    if (data && Number(error.status) > 0) receive(data, Number(error.status));
                    else if (error && Number(error.status) > 0) fail('Помилка сервера: HTTP ' + error.status);
                    else {
                        // A status of zero can mean jQuery has no cross-origin
                        // transport. Try the shell's XHR directly, only once.
                        nativeError = detail(error);
                        sendDirect();
                    }
                }, false, { dataType: 'json', headers: key ? { 'X-API-Key': key } : {} });
                if (!finished && !direct) stage('Lampa: очікування відповіді');
            } else sendDirect();
        } catch (error) {
            if (finished) throw error;
            nativeError = detail(error);
            sendDirect();
        }
        return { abort: function () {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            stop();
        } };
    }

    function open(card) {
        if (activeFlow) activeFlow.cancel();
        var previous = Lampa.Controller.enabled();
        var controller = previous && previous.name || 'full';
        var serial = 0;
        var pending;
        var title;
        var voice;
        var seasons;
        var season;
        var results = [];
        var query = card.original_title || card.original_name || card.title || card.name || '';
        var localized = card.title || card.name || '';
        var year = String(card.release_date || card.first_air_date || '').slice(0, 4);

        function cancel() {
            serial++;
            if (pending) pending.abort();
            pending = null;
        }
        function finish() { cancel(); Lampa.Controller.toggle(controller); }
        activeFlow = { cancel: cancel };

        function menu(caption, items, back) {
            Lampa.Select.show({ title: caption, items: items.map(function (item) {
                return { title: escape(item.title), subtitle: escape(item.subtitle), selected: !!item.selected,
                    noenter: !!item.noenter, onSelect: item.select };
            }), onBack: back || finish });
        }

        function load(route, params, caption, next, back) {
            cancel();
            var ticket = serial;
            menu(caption, [{ title: 'Завантаження…', noenter: true }, { title: 'Скасувати', select: function () { cancel(); back(); } }], function () { cancel(); back(); });
            var settled = false;
            var handle = request(route, params, function (data, base) {
                settled = true;
                if (ticket !== serial) return;
                pending = null;
                // Select.close() invokes onBack in Lampa. Replace the loading
                // menu directly so a response cannot restore the card controller.
                next(data, base);
            }, function (message) {
                settled = true;
                if (ticket !== serial) return;
                pending = null;
                menu('HDRezka — помилка', [{ title: message, noenter: true },
                    { title: 'Спробувати ще раз', select: function () { load(route, params, caption, next, back); } },
                    { title: 'Назад', select: back }], back);
            });
            if (!settled && ticket === serial) pending = handle;
        }

        function manual() {
            Lampa.Input.edit({ title: 'Пошук на HDRezka', value: query, free: true, nosave: true }, function (value) {
                query = String(value || '').trim();
                if (query.length >= 2) search(false);
                else showResults();
            });
        }

        function search(fallback) {
            load('search', { q: query }, 'HDRezka — пошук', function (data) {
                results = data.items || [];
                if (!results.length && fallback && localized.length >= 2 && localized !== query) {
                    query = localized;
                    search(false);
                    return;
                }
                results.sort(function (a, b) { return Number(b.year === year) - Number(a.year === year); });
                showResults();
            }, finish);
        }

        function showResults() {
            var items = results.map(function (item) {
                return { title: item.title, subtitle: item.description, select: function () {
                    load('title', { path: item.path }, item.title, function (data) { title = data; showVoices(); }, showResults);
                } };
            });
            if (!items.length) items.push({ title: 'Нічого не знайдено. Спробуйте іншу назву.', noenter: true });
            items.push({ title: 'Змінити назву пошуку', subtitle: query, select: manual });
            menu('HDRezka — оберіть фільм або серіал', items);
        }

        function showVoices() {
            var voices = title.voices.slice();
            if (Lampa.Storage.get('hdrezka_ukrainian', true)) voices.sort(function (a, b) { return Number(b.language === 'uk') - Number(a.language === 'uk'); });
            menu(title.title + ' — озвучення', voices.map(function (item) {
                return { title: (item.language === 'uk' ? '🇺🇦 ' : '') + item.name,
                    subtitle: item.premium ? 'Потрібна відповідна підписка HDRezka' : '',
                    select: function () {
                        voice = item;
                        if (title.kind === 'series') {
                            load('episodes', { path: title.path, translator: voice.id }, 'Сезони', function (data) {
                                seasons = data.seasons;
                                showSeasons();
                            }, showVoices);
                        } else stream(null, showVoices);
                    } };
            }), showResults);
        }

        function showSeasons() {
            menu(title.title + ' — сезони', seasons.map(function (item) {
                return { title: item.title, subtitle: item.episodes.length + ' серій', select: function () { season = item; showEpisodes(); } };
            }), showVoices);
        }

        function showEpisodes() {
            menu(title.title + ' — ' + season.title, season.episodes.map(function (item) {
                return { title: item.title, subtitle: voice.name, select: function () { stream(item, showEpisodes); } };
            }), showSeasons);
        }

        function stream(episode, back) {
            var args = { path: title.path, translator: voice.id, format: Lampa.Storage.get('hdrezka_format', 'hls') };
            if (episode) { args.season = season.id; args.episode = episode.id; }
            load('stream', args, 'HDRezka — якість', function (data, base) {
                menu('Оберіть якість', data.streams.map(function (quality) {
                    return { title: quality.label, subtitle: voice.name, select: function () {
                        var name = title.title + (episode ? ' [S' + season.id + ':E' + episode.id + '] ' + episode.title : '');
                        var playlist = (data.playlist || []).map(function (item) {
                            var entry = { title: title.title + ' [S' + item.season + ':E' + item.episode + '] ' + item.title,
                                url: base + (item.quality && item.quality[quality.label] || item.url),
                                season: Number(item.season), episode: Number(item.episode), card: card, source: 'HDRezka', voice_name: voice.name };
                            if (episode && String(item.episode) === String(episode.id) && String(item.season) === String(season.id)) {
                                entry.url = base + quality.url;
                                entry.selected = true;
                            }
                            if (Lampa.Timeline && Lampa.Utils) entry.timeline = Lampa.Timeline.view(Lampa.Utils.hash('hdrezka:' + title.path + ':' + item.season + ':' + item.episode));
                            return entry;
                        });
                        var subtitles = (data.subtitles || []).map(function (item) { return { label: item.label, url: item.url.charAt(0) === '/' ? base + item.url : item.url }; });
                        var play = { title: name, url: base + quality.url, subtitles: subtitles, card: card,
                            source: 'HDRezka', voice_name: voice.name, playlist: playlist };
                        if (episode) { play.season = Number(season.id); play.episode = Number(episode.id); }
                        if (Lampa.Timeline && Lampa.Utils) play.timeline = Lampa.Timeline.view(Lampa.Utils.hash('hdrezka:' + title.path + ':' + (episode ? season.id + ':' + episode.id : 'movie')));
                        finish();
                        Lampa.Player.play(play);
                        Lampa.Player.playlist(playlist.length ? playlist : [play]);
                    } };
                }), back);
            }, back);
        }

        if (query.length >= 2) search(true);
        else manual();
    }

    function settings() {
        Lampa.SettingsApi.addComponent({ component: 'hdrezka_local', name: 'HDRezka', icon: icon });
        function param(name, type, values, value, label, description) {
            Lampa.SettingsApi.addParam({ component: 'hdrezka_local', param: { name: name, type: type, values: values, default: value },
                field: { name: label, description: description } });
        }
        param('hdrezka_server', 'input', '', defaultServer, 'Адреса сервера', 'Адреса вашого сервера HDRezka, без /hdrezka.js. GitHub Pages розміщує тільки плагін.');
        param('hdrezka_key', 'input', '', '', 'Ключ сервера', 'Значення API_KEY, якщо його налаштовано на сервері.');
        param('hdrezka_format', 'select', { hls: 'HLS — Apple TV', mp4: 'MP4' }, 'hls', 'Формат відео', 'Програвач обирається у звичайних налаштуваннях Lampa.');
        param('hdrezka_ukrainian', 'trigger', '', true, 'Українські озвучення першими', 'Показувати українські озвучення на початку списку.');
        var check = Lampa.Storage.get('hdrezka_check_result', null);
        var checkView;
        var checkSerial = 0;
        var checkPending;
        function showCheck() {
            var text = 'Плагін ' + version + '. Натисніть для перевірки (до 15 с).';
            if (check && typeof check === 'object') {
                if (check.state === 'running' && Date.now() - check.started >= 15000) {
                    check.state = 'error';
                    check.message = 'Перевірка не завершилася за 15 с. Нижче — останній виконаний етап.';
                }
                text += '\n' + (check.server ? 'Сервер: ' + check.server + '\n' : '') + check.message;
                if (check.phase) text += '\nЕтап: ' + check.phase;
            }
            if (checkView) checkView.find('.settings-param__descr').text(text).css('white-space', 'pre-line');
        }
        function saveCheck() {
            showCheck();
            try { Lampa.Storage.set('hdrezka_check_result', check); } catch (error) {}
        }
        Lampa.SettingsApi.addParam({ component: 'hdrezka_local', param: { name: 'hdrezka_check', type: 'button' },
            field: { name: 'Перевірити підключення', description: 'Плагін ' + version + '. Результат залишиться під цією кнопкою.' },
            onRender: function (item) {
                checkView = $(item);
                showCheck();
                item.on('hover:enter', function () {
                    // Keep diagnostics in the settings row and storage. Native
                    // shells can lose or replace transient Noty notifications.
                    if (check && check.state === 'running' && Date.now() - check.started < 15000) { showCheck(); return; }
                    var ticket = ++checkSerial;
                    check = { state: 'running', started: Date.now(), message: 'Перевірка підключення…', phase: 'Початок', server: '', version: version };
                    try { check.server = endpoint(); } catch (error) {}
                    saveCheck();
                    if (checkPending) checkPending.abort();
                    var settled = false;
                    var handle = request('health', {}, function (data) {
                        if (ticket !== checkSerial) return;
                        settled = true;
                        checkPending = null;
                        check.state = 'ok';
                        check.message = 'Сервер працює. Дзеркало: ' + data.mirror;
                        check.phase = 'Отримано відповідь API';
                        saveCheck();
                    }, function (message) {
                        if (ticket !== checkSerial) return;
                        settled = true;
                        checkPending = null;
                        check.state = 'error';
                        check.message = message;
                        saveCheck();
                    }, function (phase) {
                        if (ticket !== checkSerial) return;
                        check.phase = phase;
                        saveCheck();
                    });
                    if (!settled) checkPending = handle;
                });
            } });
    }

    function start() {
        if (started) return;
        if (!window.Lampa || !window.jQuery || !Lampa.SettingsApi || !Lampa.Select || !Lampa.Player) return;
        started = true;
        settings();
        if (Lampa.Manifest) Lampa.Manifest.plugins = { type: 'video', name: 'HDRezka', version: version, description: 'Фільми та серіали через власний сервер' };
        Lampa.Listener.follow('full', function (event) {
            if (event.type !== 'complite' || !event.data || !event.data.movie) return;
            var root = event.body || event.object && event.object.activity && event.object.activity.render();
            if (!root) return;
            root = $(root);
            if (root.find('.view--hdrezka-local').length) return;
            var buttons = root.find('.full-start-new__buttons, .full-start__buttons').first();
            if (!buttons.length) return;
            var button = $('<div class="full-start__button selector view--hdrezka-local">' + icon + '<span>HDRezka</span></div>');
            button.on('hover:enter', function () { open(event.data.movie); });
            buttons.append(button);
        });
    }

    function ready() {
        if (!window.Lampa || !Lampa.Listener) { setTimeout(ready, 300); return; }
        if (window.appready) start();
        else Lampa.Listener.follow('app', function (event) { if (event.type === 'ready') start(); });
    }
    ready();
}());
