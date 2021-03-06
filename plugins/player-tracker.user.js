// ==UserScript==
// @id             iitc-plugin-player-tracker@breunigs
// @name           IITC Plugin: Player tracker
// @category       Layer
// @version        0.11.0.@@DATETIMEVERSION@@
// @namespace      https://github.com/jonatkins/ingress-intel-total-conversion
// @updateURL      @@UPDATEURL@@
// @downloadURL    @@DOWNLOADURL@@
// @description    [@@BUILDNAME@@-@@BUILDDATE@@] Draw trails for the path a user took onto the map based on status messages in COMMs. Uses up to three hours of data. Does not request chat data on its own, even if that would be useful.
// @include        https://www.ingress.com/intel*
// @include        http://www.ingress.com/intel*
// @match          https://www.ingress.com/intel*
// @match          http://www.ingress.com/intel*
// @grant          none
// ==/UserScript==

@@PLUGINSTART@@

// PLUGIN START ////////////////////////////////////////////////////////
window.PLAYER_TRACKER_MAX_TIME = 3*60*60*1000; // in milliseconds
window.PLAYER_TRACKER_MIN_ZOOM = 9;
window.PLAYER_TRACKER_MIN_OPACITY = 0.3;
window.PLAYER_TRACKER_LINE_COLOUR = '#FF00FD';


// use own namespace for plugin
window.plugin.playerTracker = function() {};

window.plugin.playerTracker.setup = function() {
  var iconEnlImage = '@@INCLUDEIMAGE:images/marker-green.png@@';
  var iconEnlRetImage = '@@INCLUDEIMAGE:images/marker-green-2x.png@@';
  var iconResImage = '@@INCLUDEIMAGE:images/marker-blue.png@@';
  var iconResRetImage = '@@INCLUDEIMAGE:images/marker-blue-2x.png@@';

  plugin.playerTracker.iconEnl = L.Icon.Default.extend({options: {
    iconUrl: iconEnlImage,
    iconRetinaUrl: iconEnlRetImage
  }});
  plugin.playerTracker.iconRes = L.Icon.Default.extend({options: {
    iconUrl: iconResImage,
    iconRetinaUrl: iconResRetImage
  }});

  plugin.playerTracker.drawnTracesEnl = new L.LayerGroup();
  plugin.playerTracker.drawnTracesRes = new L.LayerGroup();
  // to avoid any favouritism, we'll put the player's own faction layer first
  if (PLAYER.team == 'RESISTANCE') {
    window.addLayerGroup('Player Tracker Resistance', plugin.playerTracker.drawnTracesRes, true);
    window.addLayerGroup('Player Tracker Enlightened', plugin.playerTracker.drawnTracesEnl, true);
  } else {
    window.addLayerGroup('Player Tracker Enlightened', plugin.playerTracker.drawnTracesEnl, true);
    window.addLayerGroup('Player Tracker Resistance', plugin.playerTracker.drawnTracesRes, true);
  }
  map.on('layeradd',function(obj) {
    if(obj.layer === plugin.playerTracker.drawnTracesEnl || obj.layer === plugin.playerTracker.drawnTracesRes) {
      obj.layer.eachLayer(function(marker) {
        if(marker._icon) window.setupTooltips($(marker._icon));
      });
    }
  });

  plugin.playerTracker.playerPopup = new L.Popup({offset: L.point([1,-34])});

  addHook('publicChatDataAvailable', window.plugin.playerTracker.handleData);

  window.map.on('zoomend', function() {
    window.plugin.playerTracker.zoomListener();
  });
  window.plugin.playerTracker.zoomListener();
  
  plugin.playerTracker.setupUserSearch();
}

window.plugin.playerTracker.stored = {};

plugin.playerTracker.onClickListener = function(event) {
  var marker = event.target;

  var ll = marker.options.referenceToPortal.split(",");
  window.selectPortalByLatLng(ll[0]/1E6, ll[1]/1E6);

  if (marker.options.desc) {
    plugin.playerTracker.playerPopup.setContent(marker.options.desc);
    plugin.playerTracker.playerPopup.setLatLng(marker.getLatLng());
    map.openPopup(plugin.playerTracker.playerPopup);
  }
};

// force close all open tooltips before markers are cleared
window.plugin.playerTracker.closeIconTooltips = function() {
    plugin.playerTracker.drawnTracesRes.eachLayer(function(layer) {
      if ($(layer._icon)) { $(layer._icon).tooltip('close');}
    });
    plugin.playerTracker.drawnTracesEnl.eachLayer(function(layer) {
      if ($(layer._icon)) { $(layer._icon).tooltip('close');}
    });
}

window.plugin.playerTracker.zoomListener = function() {
  var ctrl = $('.leaflet-control-layers-selector + span:contains("Player Tracker")').parent();
  if(window.map.getZoom() < window.PLAYER_TRACKER_MIN_ZOOM) {
    if (!window.isTouchDevice()) plugin.playerTracker.closeIconTooltips();
    plugin.playerTracker.drawnTracesEnl.clearLayers();
    plugin.playerTracker.drawnTracesRes.clearLayers();
    ctrl.addClass('disabled').attr('title', 'Zoom in to show those.');
    //note: zoomListener is also called at init time to set up things, so we only need to do this in here
    window.chat.backgroundChannelData('plugin.playerTracker', 'all', false);   //disable this plugin's interest in 'all' COMM
  } else {
    ctrl.removeClass('disabled').attr('title', '');
    //note: zoomListener is also called at init time to set up things, so we only need to do this in here
    window.chat.backgroundChannelData('plugin.playerTracker', 'all', true);    //enable this plugin's interest in 'all' COMM
  }
}

window.plugin.playerTracker.getLimit = function() {
 return new Date().getTime() - window.PLAYER_TRACKER_MAX_TIME;
}

window.plugin.playerTracker.discardOldData = function() {
  var limit = plugin.playerTracker.getLimit();
  $.each(plugin.playerTracker.stored, function(plrname, player) {
    var i;
    var ev = player.events;
    for(i = 0; i < ev.length; i++) {
      if(ev[i].time >= limit) break;
    }
    if(i === 0) return true;
    if(i === ev.length) return delete plugin.playerTracker.stored[plrname];
    plugin.playerTracker.stored[plrname].events.splice(0, i);
  });
}

window.plugin.playerTracker.eventHasLatLng = function(ev, lat, lng) {
  var hasLatLng = false;
  $.each(ev.latlngs, function(ind, ll) {
    if(ll[0] === lat && ll[1] === lng) {
      hasLatLng = true;
      return false;
    }
  });
  return hasLatLng;
}

window.plugin.playerTracker.processNewData = function(data) {
  var limit = plugin.playerTracker.getLimit();
  $.each(data.raw.success, function(ind, json) {
    // skip old data
    if(json[1] < limit) return true;

    // find player and portal information
    var plrname, lat, lng, id=null, name, address;
    var skipThisMessage = false;
    $.each(json[2].plext.markup, function(ind, markup) {
      switch(markup[0]) {
      case 'TEXT':
        // Destroy link and field messages depend on where the link or
        // field was originally created. Therefore it’s not clear which
        // portal the player is at, so ignore it.
        if(markup[1].plain.indexOf('destroyed the Link') !== -1
          || markup[1].plain.indexOf('destroyed a Control Field') !== -1
          || markup[1].plain.indexOf('Your Link') !== -1) {
          skipThisMessage = true;
          return false;
        }
        break;
      case 'PLAYER':
        plrname = markup[1].plain;
        break;
      case 'PORTAL':
        // link messages are “player linked X to Y” and the player is at
        // X.
        lat = lat ? lat : markup[1].latE6/1E6;
        lng = lng ? lng : markup[1].lngE6/1E6;

        // no GUID in the data any more - but we need some unique string. use the latE6,lngE6
        id = markup[1].latE6+","+markup[1].lngE6;

        name = name ? name : markup[1].name;
        address = address ? address : markup[1].address;
        break;
      }
    });

    // skip unusable events
    if(!plrname || !lat || !lng || !id || skipThisMessage) return true;

    var newEvent = {
      latlngs: [[lat, lng]],
      ids: [id],
      time: json[1],
      name: name,
      address: address
    };

    var playerData = window.plugin.playerTracker.stored[plrname];

    // short-path if this is a new player
    if(!playerData || playerData.events.length === 0) {
      plugin.playerTracker.stored[plrname] = {
        nick: plrname,
        team: json[2].plext.team,
        events: [newEvent]
      };
      return true;
    }

    var evts = playerData.events;
    // there’s some data already. Need to find correct place to insert.
    var i;
    for(i = 0; i < evts.length; i++) {
      if(evts[i].time > json[1]) break;
    }

    var cmp = Math.max(i-1, 0);

    // so we have an event that happened at the same time. Most likely
    // this is multiple resos destroyed at the same time.
    if(evts[cmp].time === json[1]) {
      evts[cmp].latlngs.push([lat, lng]);
      evts[cmp].ids.push(id);
      plugin.playerTracker.stored[plrname].events = evts;
      return true;
    }

    // the time changed. Is the player still at the same location?

    // assume this is an older event at the same location. Then we need
    // to look at the next item in the event list. If this event is the
    // newest one, there may not be a newer event so check for that. If
    // it really is an older event at the same location, then skip it.
    if(evts[cmp+1] && plugin.playerTracker.eventHasLatLng(evts[cmp+1], lat, lng))
      return true;

    // if this event is newer, need to look at the previous one
    var sameLocation = plugin.playerTracker.eventHasLatLng(evts[cmp], lat, lng);

    // if it’s the same location, just update the timestamp. Otherwise
    // push as new event.
    if(sameLocation) {
      evts[cmp].time = json[1];
    } else {
      evts.splice(i, 0,  newEvent);
    }

    // update player data
    plugin.playerTracker.stored[plrname].events = evts;
  });
}

window.plugin.playerTracker.getLatLngFromEvent = function(ev) {
//TODO? add weight to certain events, or otherwise prefer them, to give better locations?
  var lats = 0;
  var lngs = 0;
  $.each(ev.latlngs, function(i, latlng) {
    lats += latlng[0];
    lngs += latlng[1];
  });

  return L.latLng(lats / ev.latlngs.length, lngs / ev.latlngs.length);
}

window.plugin.playerTracker.ago = function(time, now) {
  var s = (now-time) / 1000;
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  var returnVal = m + 'm';
  if(h > 0) {
    returnVal = h + 'h' + returnVal;
  }
  return returnVal;
}

window.plugin.playerTracker.drawData = function() {
  var isTouchDev = window.isTouchDevice();

  var gllfe = plugin.playerTracker.getLatLngFromEvent;

  var polyLineByAgeEnl = [[], [], [], []];
  var polyLineByAgeRes = [[], [], [], []];

  var split = PLAYER_TRACKER_MAX_TIME / 4;
  var now = new Date().getTime();
  $.each(plugin.playerTracker.stored, function(plrname, playerData) {
    if(!playerData || playerData.events.length === 0) {
      console.warn('broken player data for plrname=' + plrname);
      return true;
    }

    // gather line data and put them in buckets so we can color them by
    // their age
    var playerLine = [];
    for(var i = 1; i < playerData.events.length; i++) {
      var p = playerData.events[i];
      var ageBucket = Math.min(parseInt((now - p.time) / split), 4-1);
      var line = [gllfe(p), gllfe(playerData.events[i-1])];

      if(playerData.team === 'RESISTANCE')
        polyLineByAgeRes[ageBucket].push(line);
      else
        polyLineByAgeEnl[ageBucket].push(line);
    }

    var evtsLength = playerData.events.length;
    var last = playerData.events[evtsLength-1];
    var ago = plugin.playerTracker.ago;

    // tooltip for marker - no HTML - and not shown on touchscreen devices
    var tooltip = isTouchDev ? '' : (playerData.nick+', '+ago(last.time, now)+' ago');

    // popup for marker
    var cssClass = playerData.team === 'RESISTANCE' ? 'res' : 'enl';
    var popup = '<span class="nickname '+cssClass+'" style="font-weight:bold;">' + playerData.nick + '</span>';

    if(window.plugin.guessPlayerLevels !== undefined &&
       window.plugin.guessPlayerLevels.fetchLevelDetailsByPlayer !== undefined) {
      function getLevel(lvl) {
        return '<span style="padding:4px;color:white;background-color:'+COLORS_LVL[lvl]+'">'+lvl+'</span>';
      }
      popup += '<span style="font-weight:bold;margin-left:10px;">';

      var playerLevelDetails = window.plugin.guessPlayerLevels.fetchLevelDetailsByPlayer(plrname);
      if(playerLevelDetails.min == 8) {
        popup += 'Level ' + getLevel(8);
      } else {
        popup += 'Min level: ' + getLevel(playerLevelDetails.min);
        if(playerLevelDetails.min != playerLevelDetails.guessed)
          popup += ', guessed level: ' + getLevel(playerLevelDetails.guessed);
      }

      popup += '</span>';
    }
    
    popup += '<br>'
        + ago(last.time, now) + ' ago<br>'
        + window.chat.getChatPortalName(last);
    // show previous data in popup
    if(evtsLength >= 2) {
      popup += '<br>&nbsp;<br>previous locations:<br>'
          + '<table style="border-spacing:0">';
    }
    for(var i = evtsLength - 2; i >= 0 && i >= evtsLength - 10; i--) {
      var ev = playerData.events[i];
      popup += '<tr align="left"><td>' + ago(ev.time, now) + '</td>'
          + '<td>ago</td>'
          + '<td>' + window.chat.getChatPortalName(ev) + '</td></tr>';
    }
    if(evtsLength >= 2)
      popup += '</table>';

    // calculate the closest portal to the player
    var eventPortal = []
    var closestPortal;
    var mostPortals = 0;
    $.each(last.ids, function(i, id) {
      if(eventPortal[id]) {
        eventPortal[id]++;
      } else {
        eventPortal[id] = 1;
      }
      if(eventPortal[id] > mostPortals) {
        mostPortals = eventPortal[id];
        closestPortal = id;
      }
    });

    // marker opacity
    var relOpacity = 1 - (now - last.time) / window.PLAYER_TRACKER_MAX_TIME
    var absOpacity = window.PLAYER_TRACKER_MIN_OPACITY + (1 - window.PLAYER_TRACKER_MIN_OPACITY) * relOpacity;

    // marker itself
    var icon = playerData.team === 'RESISTANCE' ?  new plugin.playerTracker.iconRes() :  new plugin.playerTracker.iconEnl();
// as per OverlappingMarkerSpiderfier docs, click events (popups, etc) must be handled via it rather than the standard
// marker click events. so store the popup text in the options, then display it in the oms click handler
    var m = L.marker(gllfe(last), {icon: icon, referenceToPortal: closestPortal, opacity: absOpacity, desc: popup, title: tooltip});
    m.addEventListener('spiderfiedclick', plugin.playerTracker.onClickListener);

//    m.bindPopup(title);

    if (tooltip) {
      // ensure tooltips are closed, sometimes they linger
      m.on('mouseout', function() { $(this._icon).tooltip('close'); });
    }

    m.addTo(playerData.team === 'RESISTANCE' ? plugin.playerTracker.drawnTracesRes : plugin.playerTracker.drawnTracesEnl);
    window.registerMarkerForOMS(m);

    // jQueryUI doesn’t automatically notice the new markers
    if (!isTouchDev) {
      window.setupTooltips($(m._icon));
    }
  });

  // draw the poly lines to the map
  $.each(polyLineByAgeEnl, function(i, polyLine) {
    if(polyLine.length === 0) return true;

    var opts = {
      weight: 2-0.25*i,
      color: PLAYER_TRACKER_LINE_COLOUR,
      clickable: false,
      opacity: 1-0.2*i,
      dashArray: "5,8"
    };

    $.each(polyLine,function(ind,poly) {
      L.polyline(poly, opts).addTo(plugin.playerTracker.drawnTracesEnl);
    });
  });
  $.each(polyLineByAgeRes, function(i, polyLine) {
    if(polyLine.length === 0) return true;

    var opts = {
      weight: 2-0.25*i,
      color: PLAYER_TRACKER_LINE_COLOUR,
      clickable: false,
      opacity: 1-0.2*i,
      dashArray: "5,8"
    };

    $.each(polyLine, function(ind,poly) {
      L.polyline(poly, opts).addTo(plugin.playerTracker.drawnTracesRes);
    });
  });
}

window.plugin.playerTracker.handleData = function(data) {
  if(window.map.getZoom() < window.PLAYER_TRACKER_MIN_ZOOM) return;

  plugin.playerTracker.discardOldData();
  plugin.playerTracker.processNewData(data);
  if (!window.isTouchDevice()) plugin.playerTracker.closeIconTooltips();

  plugin.playerTracker.drawnTracesEnl.clearLayers();
  plugin.playerTracker.drawnTracesRes.clearLayers();
  plugin.playerTracker.drawData();
}

window.plugin.playerTracker.findUserPosition = function(nick) {
  nick = nick.toLowerCase();
  var foundPlayerData = undefined;
  $.each(plugin.playerTracker.stored, function(plrname, playerData) {
    if (playerData.nick.toLowerCase() === nick) {
      foundPlayerData = playerData;
      return false;
    }
  });
  
  if (!foundPlayerData) {
    return false;
  }
  
  var evtsLength = foundPlayerData.events.length;
  var last = foundPlayerData.events[evtsLength-1];
  return plugin.playerTracker.getLatLngFromEvent(last);
}

window.plugin.playerTracker.centerMapOnUser = function(nick) {
  var position = plugin.playerTracker.findUserPosition(nick);
  
  if (position === false) {
    return false;
  }
  
  if(window.isSmartphone()) window.smartphone.mapButton.click();
  window.map.setView(position, map.getZoom());
}

window.plugin.playerTracker.onNicknameClicked = function(info) {
  if (info.event.ctrlKey || info.event.metaKey) {
    plugin.playerTracker.centerMapOnUser(info.nickname);
    return false;
  }
}

window.plugin.playerTracker.onGeoSearch = function(search) {
  if (/^@/.test(search)) {
    plugin.playerTracker.centerMapOnUser(search.replace(/^@/, ''));
    return false;
  }
}

window.plugin.playerTracker.setupUserSearch = function() {
  addHook('nicknameClicked', window.plugin.playerTracker.onNicknameClicked);
  addHook('geoSearch', window.plugin.playerTracker.onGeoSearch);
  
  var geoSearch = $('#geosearch');
  var beforeEllipsis = /(.*)…/.exec(geoSearch.attr('placeholder'))[1];
  geoSearch.attr('placeholder', beforeEllipsis + ' or @player…');
}


var setup = plugin.playerTracker.setup;

// PLUGIN END //////////////////////////////////////////////////////////

@@PLUGINEND@@
