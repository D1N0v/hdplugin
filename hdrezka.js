/* HDRezka for Lampa MX, v1.0.1. ES5, no external browser dependencies. */
(function () {
    'use strict';
    if (window.lampaHdrezkaLoaded) return;
    window.lampaHdrezkaLoaded = true;

    var defaultServer = /* SERVER_DEFAULT */ '';
    // The companion server injects its URL here. A static host (GitHub Pages)
    // serves only this file; its origin must never be used as the API endpoint.
    var started = false;
    var activeFlow = null;
    var icon = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';

    function escape(value) {
        return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function endpoint() {
        var value = String(Lampa.Storage.get('hdrezka_server', defaultServer) || defaultServer).replace(/\/+$/, '').trim();
        if (!/^https?:\/\/[^\s/?#]+$/i.test(value) || value.indexOf('@') !== -1) throw new Error('Вкажіть адресу сервера в Налаштування → HDRezka.');
        return value;
    }

    function request(route, params, success, failure) {
        var base;
        try { base = endpoint(); } catch (error) { failure(error.message); return null; }
        var query = Object.keys(params).map(function (key) { return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]); }).join('&');
        var xhr = new XMLHttpRequest();
        xhr.open('GET', base + '/api/' + route + (query ? '?' + query : ''), true);
        xhr.timeout = 45000;
        var key = String(Lampa.Storage.get('hdrezka_key', '') || '');
        if (key) xhr.setRequestHeader('X-API-Key', key);
        xhr.onload = function () {
            var data;
            try { data = JSON.parse(xhr.responseText); } catch (error) { failure('Сервер повернув некоректну відповідь. Перевірте адресу сервера.'); return; }
            if (xhr.status < 200 || xhr.status >= 300 || data.error) {
                failure(data.error && data.error.message || 'Помилка сервера: HTTP ' + xhr.status);
                return;
            }
            success(data, base);
        };
        xhr.onerror = function () { failure('Сервер HDRezka недоступний. Перевірте адресу, Wi-Fi та HTTP/HTTPS.'); };
        xhr.ontimeout = function () { failure('Час очікування вичерпано. Перевірте сервер та дзеркало HDRezka.'); };
        xhr.send();
        return xhr;
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
            pending = request(route, params, function (data, base) {
                if (ticket !== serial) return;
                pending = null;
                // Select.close() invokes onBack in Lampa. Replace the loading
                // menu directly so a response cannot restore the card controller.
                next(data, base);
            }, function (message) {
                if (ticket !== serial) return;
                pending = null;
                menu('HDRezka — помилка', [{ title: message, noenter: true },
                    { title: 'Спробувати ще раз', select: function () { load(route, params, caption, next, back); } },
                    { title: 'Назад', select: back }], back);
            });
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
        Lampa.SettingsApi.addParam({ component: 'hdrezka_local', param: { name: 'hdrezka_check', type: 'button' },
            field: { name: 'Перевірити підключення', description: 'Перевіряє сервер та ключ доступу.' },
            onRender: function (item) {
                item.on('hover:enter', function () {
                    request('health', {}, function (data) { Lampa.Noty.show('Сервер працює. Дзеркало: ' + escape(data.mirror)); }, function (message) { Lampa.Noty.show(escape(message)); });
                });
            } });
    }

    function start() {
        if (started) return;
        if (!window.Lampa || !window.jQuery || !Lampa.SettingsApi || !Lampa.Select || !Lampa.Player) return;
        started = true;
        settings();
        if (Lampa.Manifest) Lampa.Manifest.plugins = { type: 'video', name: 'HDRezka', version: '1.0.1', description: 'Фільми та серіали через власний сервер' };
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
