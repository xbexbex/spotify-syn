const express = require("express");
const axios = require("axios");
const app = express();
const qs = require("qs");
const fs = require("fs");
const spawn = require("child_process").spawn;

const conf = JSON.parse(fs.readFileSync("config.json", "utf8"));

const pollInterval = 200;

let scriptCallTimeStamp = Date.now();
let lastScriptCommand = "";
let lastId = "";

const errorMsg = (message) => {
  console.error(new Date(Date.now()).toLocaleString() + ": " + message);
};

const encodedAuth = Buffer.from(
  `${conf.clientId}:${conf.clientSecret}`
).toString("base64");
const redirectUri = `${conf.address}:${conf.port}/callback`;

const confSave = async () => {
  data = JSON.stringify(conf);
  fs.writeFileSync("config.json", data, "utf8", () => {});
};

const refreshAccessToken = async (refreshToken) => {
  data = qs.stringify({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const headers = {
    Authorization: "Basic " + encodedAuth,
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  };

  const sRes = await axios.post(
    "https://accounts.spotify.com/api/token",
    data,
    { headers }
  );

  return sRes.data.access_token;
};

const getDevices = async (accessToken, timeout) => {
  const headers = {
    Authorization: "Bearer " + accessToken,
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  };

  const sRes = await axios.get("https://api.spotify.com/v1/me/player/devices", {
    headers,
    timeout: timeout,
  });

  return sRes.data.devices;
};

const getCurrentPlayback = async (accessToken, timeout) => {
  const headers = {
    Authorization: "Bearer " + accessToken,
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  };

  const sRes = await axios.get("https://api.spotify.com/v1/me/player", {
    headers,
    timeout,
  });

  return sRes.data;
};

const transferCurrentPlayback = async (id, accessToken, timeout) => {
  const data = JSON.stringify({
    device_ids: [id],
  });

  const headers = {
    Authorization: "Bearer " + accessToken,
    "Content-Type": "application/json",
  };

  const sRes = await axios.put("https://api.spotify.com/v1/me/player", data, {
    headers,
    timeout: timeout,
  });

  if (sRes) {
    return true;
  }

  return false;
};

// const setVolume = async (id, accessToken) => {
//   try {
//     const params = {
//       volume_percent: 0,
//       device_id: id,
//     };

//     const headers = {
//       Authorization: "Bearer " + accessToken,
//       "Content-Type": "application/json",
//     };

//     const sRes = await axios.put(
//       "https://api.spotify.com/v1/me/player/volume",
//       {},
//       {
//         headers,
//         params,
//         timeout: 5000,
//       }
//     );

//     if (sRes) {
//       return true;
//     }

//     return false;
//   } catch (err) {
//     console.log(err);
//   }
// };

app.get("/", async (req, res) => {
  res.redirect(
    `https://accounts.spotify.com/authorize?client_id=${conf.clientId}&response_type=code&redirect_uri=${redirectUri}&scope=user-read-playback-state%20user-modify-playback-state&state=1234`
  );
});

app.get("/devices", async (req, res) => {
  const devices = await getDevices(conf.accessToken, 0);

  if (devices) {
    res.send(devices);
    return;
  }

  res.send("devices not found");
  return;
});

app.get("/callback", async (req, res) => {
  const code = req.query.code;
  if (code) {
    const data = qs.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    });

    const headers = {
      Authorization: "Basic " + encodedAuth,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    };

    try {
      const sRes = await axios.post(
        "https://accounts.spotify.com/api/token",
        data,
        { headers }
      );

      conf.accessToken = sRes.data.access_token;
      conf.refreshToken = sRes.data.refresh_token;
      confSave();

      res.redirect("/devices");
      return;
    } catch (err) {
      errorMsg(err.response.status);
      err.response.message && errorMsg(err.response.message);
    }
  }
  res.send("Authorization failed");
  return;
});

const callRemoteScript = (sPath, command) => {
  const ts = Date.now();

  if (ts - scriptCallTimeStamp > 3500 || lastScriptCommand !== command) {
    spawn("python3", [
      sPath + "broadlink_cli",
      "--device",
      "@" + sPath + "d.device",
      "--send",
      "@" + sPath + command,
    ]);

    lastScriptCommand = command;
    scriptCallTimeStamp = ts;
  }
};

const pollDevices = async () => {
  try {
    const currentPlayback = await getCurrentPlayback(conf.accessToken, 1000);

    if (currentPlayback.is_playing) {
      if (conf.bannedDeviceIds.includes(currentPlayback.device.id)) {
        let id = null;

        const devices = await getDevices(conf.accessToken, conf.defaultTimeout);
        const deviceIds = [];

        for (i in devices) {
          deviceIds.push(devices[i].id);
        }

        let command = "";

        for (i in conf.preferredDeviceIds) {
          const devId = conf.preferredDeviceIds[i];

          if (deviceIds.includes(devId)) {
            id = devId;
            command = conf.remoteCommands[i];
            break;
          }
        }

        try {
          if (command !== "") {
            transferCurrentPlayback(id, conf.accessToken, conf.defaultTimeout);
            callRemoteScript(conf.scriptPath, command);
          }
        } catch (err) {
          if (err.response && err.response.status !== 404) {
            throw err;
          }
        }
      } else if (currentPlayback.device.id !== lastId) {
        if (conf.preferredDeviceIds.includes(currentPlayback.device.id)) {
          let command = "";

          for (i in conf.preferredDeviceIds) {
            if (currentPlayback.device.id === conf.preferredDeviceIds[i]) {
              command = conf.remoteCommands[i];
              break;
            }
          }

          try {
            if (command !== "") {
              callRemoteScript(conf.scriptPath, command);
            }
          } catch (err) {
            if (err.response && err.response.status !== 404) {
              throw err;
            }
          }
        }
      }
    }

    lastId = currentPlayback.device.id;
  } catch (err) {
    if (!err.response && err.code) {
      if (!["ETIMEDOUT", "ECONNABORTED", "ENETUNREACH"].includes(err.code)) {
        errorMsg(err.code);
      }
    } else if (err.response) {
      if (err.response.status === 401) {
        try {
          accessToken = await refreshAccessToken(conf.refreshToken);
          conf.accessToken = accessToken;
          confSave();

          pollTimer(1);
          return;
        } catch (err) {
          errorMsg(err.response.status);
          err.response.message && errorMsg(err.response.message);

          if ([400, 401].includes(err.response.status)) {
            conf.accessToken = null;
            conf.refreshToken = null;
            errorMsg(
              `Authorization expired. Please visit ${conf.address}:${conf.port}`
            );
            return;
          }
        }
      }
      if (err.response.status === 429) {
        errorMsg("429: too many requests");
        pollTimer(5000);
        return;
      }

      if (![408, 504].includes(err.response.status)) {
        errorMsg(err.response.status);
        err.response.message && errorMsg(err.response.message);
      }
    }
  }

  pollTimer(pollInterval);
};

const pollTimer = (timeout) => {
  setTimeout(() => {
    pollDevices();
  }, timeout);
};

if (conf.bannedDeviceIds && conf.preferredDeviceIds && conf.accessToken) {
  pollTimer(200);
}

app.listen(conf.port, "0.0.0.0", () => {
  console.log(`Spotify Syn listening at ${conf.address}:${conf.port}`);
});
