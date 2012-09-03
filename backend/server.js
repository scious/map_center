var fs = require("fs");
var http = require("http");
var express = require("express");
var app = express();
var server = http.createServer(app);
var io = require("socket.io").listen(server);
var RedisStore = require("connect-redis")(express);
var passport = require("passport");
var _ = require("underscore");

var TwitterStrategy = require("passport-twitter").Strategy;
var GoogleStrategy = require("passport-google-oauth").OAuth2Strategy;

var BroadcastSchedule = require("./broadcastSchedule");

// Server name and port. Reference environmental variables when they are set,
// and fall back to sensible defaults.
var serviceLocation = {
    portNumber: process.env.NODE_PORT || 8000,
    hostName: process.env.NODE_HOST || "127.0.0.1"
};

// Credentials, stored in non-version-controlled files
var CREDS = {
    oauth: {
        twitter: require("./credentials/oauth/twitter.json"),
        google: require("./credentials/oauth/google.json")
    },
    ssl: {
        key: fs.readFileSync("./credentials/ssl/privatekey.pem").toString(),
        cert: fs.readFileSync("./credentials/ssl/certificate.pem").toString()
    }
};

var broadcastSchedule = new BroadcastSchedule();

passport.serializeUser(function(user, done) {
    done(null, user.id);
});
passport.deserializeUser(function(id, done) {
    // For now, don't bother persisting information about the user. Simply set
    // a flag so the application can grant access to recognized users.
    done(null, { id: id });
});
function authorize(isRecognized, id, done) {
    if (isRecognized) {
        return done(null, { id: id, isRecognized: true });
    } else {
        return done("Not recognized");
    }
}

passport.use(new TwitterStrategy({
        consumerKey: CREDS.oauth.twitter.key,
        consumerSecret: CREDS.oauth.twitter.secret,
        callbackURL: "http://localhost:8000/auth/twitter/callback"
    },
    function(token, tokenSecret, profile, done) {

        var id = profile.username;
        var isRecognized = CREDS.oauth.twitter.ids.indexOf(id) > -1;

        authorize(isRecognized, id, done);

    }
));
passport.use(new GoogleStrategy({
        clientID: CREDS.oauth.google.key,
        clientSecret: CREDS.oauth.google.secret,
        callbackURL: "http://localhost:8000/auth/google/callback"
    },
    function(accessToken, refreshToken, profile, done) {

        // profile.emails is an array with the following format:
        // [ { value: "a@b.com" }, { value: "c@d.com" }, ... ]
        // So _.pluck out the e-mail addresses themselves.
        var emailAddresses = _.pluck(profile.emails, "value");
        var ids = _.intersection(CREDS.oauth.google.ids, emailAddresses);
        var id = ids[0];
        var isRecognized = (id !== undefined);

        authorize(isRecognized, id, done);
    }
));


// ----------------------------------------------------------------------------
// --[ scheduling control HTTP endpoints ]

// Dynamically generating a secret in this way means one less file will have to
// be managed outside of the repository. The drawback is that, in the event of
// a server re-start, all authenticated users will be kicked and need to re-
// authenticate.
var sessionSecret = "This is a secret." + Math.random();
var sioCookieParser = express.cookieParser(sessionSecret);
var store = new RedisStore();

// Simple Express middleware to redirect unauthorized users to the site index
var redirectUnauthorized = function(req, res, next) {
    // Certain pages should be accessible to anyone, namely: the index
    // (login) page and the authorization pages
    if (req.path === "/" || /^\/auth\//.test(req.path) ||
        // All other pages should only be served to users that have
        // properly authenticated
        (req.session && req.session.passport && req.session.passport.user)) {
        next();

    // In any other case, serve the index page
    } else {
        next("Unauthorized");
    }
};

app.configure(function() {
    app.use(express.bodyParser());
    app.use(express.cookieParser());
    app.use(express.session({ store: store, secret: sessionSecret }));
    app.use(passport.initialize());
    app.use(passport.session());
    app.use(express.static(__dirname + "/www"));
    app.use(redirectUnauthorized);
});

app.param("recId", function(req, res, next) {

    broadcastSchedule.get(req.params.recId, function(err, data) {

        if (err) {
            return next(err);
        }

        if (!data) {
            return next("resource not found");
        }

        req.recordingEvent = data;
        next();
    });
});

app.get("/auth/twitter", passport.authenticate("twitter"));
app.get("/auth/twitter/callback",
    passport.authenticate("twitter", {
        successRedirect: "/",
        failureRedirect: "/"
    }));

app.get("/auth/google", passport.authenticate("google", {
    scope: [
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/userinfo.email"
    ]}));
app.get("/auth/google/callback",
    passport.authenticate("google", {
        successRedirect: "/",
        failureRedirect: "/"
    }));

app.get("/recording/:recId?", function(req, res) {

    if (req.recordingEvent) {
        res.json(req.recordingEvent);
    } else {
        // TODO: Extend API to allow pagination by date
        broadcastSchedule.getByTime(null, function(err, broadcasts) {

            var semaphore;

            broadcasts = _.filter(broadcasts, function(broadcast) {
                return broadcast.type ==="recording";
            });

            semaphore = broadcasts.length;

            _.forEach(broadcasts, function(broadcast) {
                broadcastSchedule.getReplaysByRecordingID(broadcast.id, function(err, replays) {
                    broadcast.replays = replays;
                    semaphore--;
                    if (!semaphore) {
                        res.json(broadcasts);
                    }

                });
            });
        });
    }
});

app.post("/recording", function(req, res) {

    var eventData;

    // TODO: set up a `/replay` endpoint and infer type based on endpoint
    if (req.body.type === "recording") {

        // TODO: Share validation logic between client & server
        if(!req.body.name || !req.body.name.trim()) {
            res.statusCode = 400;
            res.end();
            return;
        }
        eventData = {
            name: req.body.name.trim(),
            timeStamp: req.body.timeStamp,
            duration: req.body.duration,
            type: req.body.type
        };
    } else {
        eventData = {
            recordingID: req.body.recordingID,
            timeStamp: req.body.timeStamp,
            type: req.body.type
        };
    }

    broadcastSchedule.create(eventData, function(err, newEvent) {
        res.json(newEvent);
    });
});
app.put("/recording/:recId", function(req, res) {

    var newEvent = {
        name: req.body.name.trim(),
        timeStamp: req.body.timeStamp,
        duration: req.body.duration
    };

    broadcastSchedule.update(req.recordingEvent.id, newEvent, function(err) {
        if (err) {
            res.statusCode = 500;
        } else {
            res.statusCode = 200;
        }
        res.end();
    });

});
app.del("/recording/:recId", function(req, res) {

    broadcastSchedule.del(req.recordingEvent.id, function(err) {
        if (err) {
            res.statusCode = 500;
        } else {
            res.statusCode = 200;
        }
        res.end();
    });

});

// Return a JSON-formatted file describing all the map events that took place
// over the corse of the recording specified. Optionally filter out map events
// according to the following parameters:
// - startTime <number>: remove events that occurred before this number of
//   milliseconds (relative to the beginning of the recording)
// - endTime <number>: remove events that occurred before this number of
//   milliseconds (relative to the beginning of the recording)
// - offset <number>: shift events the occurred in the interval by this number
//   of milliseconds
app.get("/recordingjson/:recId", function(req, res) {

    var options = {};
    var fileName;

    fileName = req.recordingEvent.id + "-";
    fileName += req.recordingEvent.name.replace(/\s+/g, "-");
    fileName += ".json";

    if (req.query.startTime) {
        options.startTime = parseInt(req.query.startTime, 10);
    }

    if (req.query.endTime) {
        options.endTime = parseInt(req.query.endTime, 10);
    }

    if (req.query.offset) {
        options.offset = parseInt(req.query.offset, 10);
    }

    broadcastSchedule.getRecordingEvent(req.recordingEvent.id,
        options,
        function(err, recording) {
            res.attachment(fileName);
            res.contentType("application/json");
            res.send(recording);
        });
});

server.listen(serviceLocation.portNumber, serviceLocation.hostName);

// ----------------------------------------------------------------------------
// --[ broadcast state management ]

var noop = function() {};
var socketEventHandlers = {
    updateMap: noop,
    connection: noop
};
var longestEvent = 2*60*60*1000;
var tickInterval = 2*1000;
var setState;
var tick = function() {

    var now = +new Date();

    var findActiveBroadcast = function(err, broadcasts) {
        var activeBroadcast;

        activeBroadcast = _.find(broadcasts, function(broadcast) {
            return broadcast.timeStamp <= now &&
                (broadcast.timeStamp + broadcast.duration) >= now;
        });


        if (!activeBroadcast) {
            setState("offAir");
            setTimeout(tick, tickInterval);
            return;
        }

        setState(activeBroadcast.type, activeBroadcast);
        setTimeout(tick, activeBroadcast.duration);
    };

    broadcastSchedule.getByTime({
        lowerTimestamp: now - longestEvent,
        // The upper timestamp should be greater than the tick interval to
        // account for the delay in retrieving broadcasts
        upperTimestamp: now + tickInterval*2,
        expandReplays: true
    }, findActiveBroadcast);
};

setState = function(state, broadcast) {

    var bindings = {
        offAir: function() {
            socketEventHandlers.updateMap = noop;
            socketEventHandlers.connection = noop;
        },
        recording: function(broadcast) {

            var currentMapState;

            var handleUpdateMap = function(mapState) {
                var changeEvent;
                // Update the "current" map state to be sent to newly-connected
                // clients
                currentMapState = mapState;

                io.sockets.emit("updateMap", mapState);

                changeEvent = {
                    // Map event timestamps are relative to the start of the
                    // recording event
                    timeStamp: +new Date() - broadcast.timeStamp,
                    mapState: mapState
                };

                broadcastSchedule.addRecordingEvent(broadcast.id, changeEvent);
            };
            var handleConnection = function(socket) {
                if (currentMapState) {
                    socket.emit("updateMap", currentMapState);
                }
            };
            socketEventHandlers.updateMap = handleUpdateMap;
            socketEventHandlers.connection = handleConnection;
        },
        replay: function(broadcast) {

            broadcastSchedule.getRecordingEvent(broadcast.recordingID, {}, function(err, recording) {

                // The following logic has been commented out in favor of an
                // alternate approach to broadcasting replays. This code
                // simulates change events and re-broadcasts them in real-time
                // to all connected clients. This means that the backend will
                // have to bear the same load under live broadcasts and replays
                // alike. The new approach (described below) avoids this, but
                // this optimization may not be necessary, in which case the
                // original approach is preferable for its simplicity.
                //
                // Due to possible delays in database requests (and the
                // imprecise nature of the event loop), the current time may
                // differ from the scheduled time. Calculate this difference
                // so map change events can be scheduled accordingly.
                /*var timeDelta = +new Date() - broadcast.timeStamp;

                _.forEach(recording, function(changeEvent) {
                    setTimeout(function() {
                        io.sockets.emit("updateMap", changeEvent.mapState);
                    }, changeEvent.timeStamp - timeDelta);
                });

                socketEventHandlers.connection = noop;
                socketEventHandlers.updateMap = noop;
                */

                // Retrieve any other replays of the current recording so that
                // clients can mimick re-broadcasting without needing to
                // refresh (especially relevant for clients who connect at the
                // end of one rebroadcast expecting to view the following
                // rebroadcast)
                broadcastSchedule.getReplaysByRecordingID(
                    broadcast.recordingID,
                    function(err, allReplays) {

                        var now = +new Date();
                        var upcomingReplays = _.filter(allReplays, function(replay) {
                            return replay.timeStamp >= now ||
                                // Due to delays caused by the program event loop
                                // and database queries, the active replay's start
                                // time may be slightly earlier than the current
                                // time. This condition ensures that in such cases,
                                // the active replay is broadcast to all clients.
                                replay.id === broadcast.id;
                        });

                        var emitReplay = function(socket) {
                            socket.emit("replay", {
                                currentTime: +new Date(),
                                startTimes: _.pluck(upcomingReplays, "timeStamp"),
                                recording: recording
                            });
                        };
                        var handleConnection = function(socket) {
                            emitReplay(socket);
                            // Clients that connect during a rebroadcast can be
                            // disconnected in order to minimize overhead
                            socket.disconnect();
                        };

                        // Immediately emit the replay event to any
                        // already-connected clients in order to support clients
                        // that connected at the end of a broadcast expecting to
                        // view the re-broadcast
                        emitReplay(io.sockets);

                        socketEventHandlers.connection = handleConnection;
                        socketEventHandlers.updateMap = noop;

                    });
            });

        }
    };

    if (state in bindings) {
        bindings[state](broadcast);
    }
};

tick();

/* socket.io does not support ad-hoc binding to all currently-connected clients
 * (**see below). This effects the approach to dynamically assigning event
 * handlers. Instead of running the following code:
 *
 *     io.sockets.on("updateMap", newUpdateMapHandler);
 *
 *  ...each socket must be individually assigned a handler when it connects.
 *  This handler can invoke a global method, and this method may be dynamically
 *  modified.
 *
 *  ** The socket.io documentation is somewhat lacking, making it difficult to
 *  confirm this deficiency.
 */
io.sockets.on("connection", function(socket) {
    socketEventHandlers.connection.apply(socket, arguments);
});

// Only clients that have authenticated through OAuth should be allowed to
// join the "broadcaster" channel. Authentication can be confirmed by locating
// the client's session ID in the Redis-connect datastore.
io.of("/broadcaster").authorization(function(handshakeData, callback) {

    // Use the cookie string from the handshake data to construct a request
    // object for use with the cookieParser middleware.
    var fakeReq = { headers: { cookie: handshakeData.headers.cookie } };

    sioCookieParser(fakeReq, {}, function(err) {

        var sessionId = fakeReq.signedCookies["connect.sid"];

        store.get(sessionId, function(err, data) {

            var isAuthorized;

            if (err) {
                return callback(err);
            }
            isAuthorized = !!(data && data.passport && data.passport.user);

            callback(null, isAuthorized);
        });
    });
}).on("connection", function(socket) {

    socket.on("updateMap", function() {
        var args = Array.prototype.slice.call(arguments);
        socketEventHandlers.updateMap.apply(socket, args);
    });
});
