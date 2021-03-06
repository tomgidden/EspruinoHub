/*
 * This file is part of EspruinoHub, a Bluetooth-MQTT bridge for
 * Puck.js/Espruino JavaScript Microcontrollers
 *
 * Copyright (C) 2016 Gordon Williams <gw@pur3.co.uk>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * ----------------------------------------------------------------------------
 *  Converts BLE advertising packets to MQTT
 * ----------------------------------------------------------------------------
 */

var noble = require('noble');
var mqtt = require('./mqttclient');
var config = require('./config');
var attributes = require('./attributes');

// List of BLE devices that are currently in range
var inRange = {};
var packetsReceived = 0;
var lastPacketsReceived = 0;
var scanStartTime = Date.now();
var isScanning = false;

function log(x) {
  console.log("<Discover> "+x);
}

// ----------------------------------------------------------------------
function onStateChange(state) {
  if (state!="poweredOn") return;
  // delay startup to allow Bleno to set discovery up
  setTimeout(function() {
    log("Starting scan...");
    noble.startScanning([], true);
  }, 1000);
};

// ----------------------------------------------------------------------
function onDiscovery(peripheral) {
  packetsReceived++;

  var addr = peripheral.address;
  var id = addr;
  if (id in config.known_devices)
    id = config.known_devices[id];
  var entered = !inRange[addr];

  if (entered) {
    inRange[addr] = {
      id : id,
      address : addr,
      peripheral: peripheral,
      name : "?",
      data : {}
    };
    mqtt.send("/ble/presence/"+id, "1");
  }
  var mqttData = {
    rssi: peripheral.rssi,
  };
  if (peripheral.advertisement.localName) {
    mqttData.name = peripheral.advertisement.localName;
    inRange[addr].name = peripheral.advertisement.localName;
  }
  inRange[addr].lastSeen = Date.now();
  inRange[addr].rssi = peripheral.rssi;

  if (peripheral.advertisement.manufacturerData) {
    var mdata = peripheral.advertisement.manufacturerData.toString('hex');

    // Include the entire raw string, incl. manufacturer, as hex
    mqttData.manufacturerData = mdata;
    mqtt.send("/ble/advertise/"+id, JSON.stringify(mqttData));

    // First two bytes is the manufacturer code (little-endian)
    // re: https://www.bluetooth.com/specifications/assigned-numbers/company-identifiers
    var manu = mdata.slice(2,4) + mdata.slice(0,2);
    var rest = mdata.slice(4);

    // Split out the manufacturer specific data
    mqtt.send("/ble/advertise/"+id+"/manufacturer/"+manu, JSON.stringify(rest));
  }
  else {
    // No manufacturer specific data
    mqtt.send("/ble/advertise/"+id, JSON.stringify(mqttData));
  }

  mqtt.send("/ble/advertise/"+id+"/rssi", JSON.stringify(peripheral.rssi));

  peripheral.advertisement.serviceData.forEach(function(d) {
    /* Don't keep sending the same old data on MQTT. Only send it if
    it's changed or >1 minute old. */
    if (inRange[addr].data[d.uuid] &&
        inRange[addr].data[d.uuid].payload.toString() == d.data.toString() &&
        inRange[addr].data[d.uuid].time > Date.now()-60000)
     return;

    mqtt.send("/ble/advertise/"+id+"/"+d.uuid, JSON.stringify(d.data));
    inRange[addr].data[d.uuid] = { payload : d.data, time : Date.now() };

    var decoded = attributes.decodeAttribute(d.uuid,d.data);
    if (decoded!=d.data) {
      for (var k in decoded) {
        mqtt.send("/ble/advertise/"+id+"/"+k, JSON.stringify(decoded[k]));
        mqtt.send("/ble/"+k+"/"+id, JSON.stringify(decoded[k]));
      }
    }
  });
}


/** If a BLE device hasn't polled in for 60 seconds, emit a presence event */
function checkForPresence() {
  var timeout = Date.now() - 60*1000; // 60 seconds

  if (!isScanning || scanStartTime>timeout)
    return; // don't check, as we're not scanning/haven't had time

  Object.keys(inRange).forEach(function(addr) {
    if (inRange[addr].lastSeen < timeout) {
      mqtt.send("/ble/presence/"+inRange[addr].id, "0");
      delete inRange[addr];
    }
  });
}

function checkIfBroken() {
  if (isScanning) {
    // If no packets for 10 seconds, restart
    if (packetsReceived==0 && lastPacketsReceived==0) {
      if (false === config.restart_on_no_advertising) {
        console.log("BLE broken? No advertising packets in " + config.advertising_timeout + " seconds.");
      } else {
        console.log("BLE broken? No advertising packets in " + config.advertising_timeout + " seconds - restarting!");
        process.exit(1);
      }
    }
  } else {
    packetsReceived = 1; // don't restart as we were supposed to not be advertising
  }
  lastPacketsReceived = packetsReceived;
  packetsReceived = 0;
}

exports.init = function() {
  noble.on('stateChange',  onStateChange);
  noble.on('discover', onDiscovery);
  noble.on('scanStart', function() {
    isScanning=true;
    scanStartTime = Date.now();
    log("Scanning started.");
  });
  noble.on('scanStop', function() { isScanning=false; log("Scanning stopped.");});
  setInterval(checkForPresence, 1000);

  if (undefined === config.advertising_timeout)
    config.advertising_timeout = 10;

  setInterval(checkIfBroken, config.advertising_timeout * 1000);
};

exports.inRange = inRange;

exports.restartScan = function() {
  if (!isScanning) {
    noble.startScanning([], true);
  }
}

exports.stopScan = function() {
  if (isScanning) {
    noble.stopScanning();
  }
}
