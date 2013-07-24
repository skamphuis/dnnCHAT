﻿//TODO: 7/23/2013   Room creation from /Join doesn't repopulate the RoomModel for all users...
//TODO: 7/23/2013   enter key binding not working for anonymous users...

//TODO: 7/23/2013   need to control the sort order on the room list

//TODO: 7/23/2013   user counts aren't working
//TODO: 7/23/2013   check on disconnections and leaving a room

//TODO: the connection fails with websockets and no fall back
//TODO: reconnections appear to keep happening for logged in users, populating the user list multiple times

function DnnChat($, ko, settings) {

    var moduleid = settings.moduleId;
    var userid = settings.userId;
    var username = settings.userName;
    var startmessage = settings.startMessage;
    var sendMessageReconnecting = settings.sendMessageReconnecting;
    var stateReconnecting = settings.stateReconnecting;

    var stateReconnected = settings.stateReconnected;
    var stateConnected = settings.stateConnected;
    var stateDisconnected = settings.stateDisconnected;
    var alreadyInRoom = settings.alreadyInRoom;
    var anonUsersRooms = settings.anonUsersRooms;
    var messageMissingRoom = settings.MessageMissingRoom;

    var defaultRoomId = settings.defaultRoomId;
    
    var emoticonsUrl = settings.emoticonsUrl; //<%= ResolveUrl(ControlPath + "images/emoticons/simple/") %>

    var focus = true;
    var pageTitle = document.title;
    var unread = 0;
    var mentions = 0;
    var firstConnection = true;

    var activeRoomId = '';

    if (username == '')
        username = 'phantom';

    $(window).focus(function () {
        focus = true;
        unread = 0;
        mentions = 0;
        //clear the title of unread
        window.setTimeout(SetTitle, 200);
    });

    $(window).blur(function () {
        focus = false;
        SetTitle();
    });

    //user connection mapping function
    function ConnectionRecord(u) {
        this.connectionRecordId = u.ConnectionRecordId;
        this.authorName = u.UserName;
        this.userId = u.UserId;
        this.moduleId = u.ModuleId;
        this.connectedDate = u.ConnectedDate;
        this.disconnectedDate = u.DisconnectedDate;
        this.ipAddress = u.IpAddress;
    }

    //user connection view model
    var usersViewModel = {
        connectionRecords: ko.observableArray([])
    };

    ko.bindingHandlers.dateString = {
        update: function (element, valueAccessor, allBindingsAccessor, viewModel) {
            var value = valueAccessor();
            var valueUnwrapped = ko.utils.unwrapObservable(value);
            if (valueUnwrapped) {
                //TODO: add a formatting option for the date
                $(element).text(moment.utc(valueUnwrapped).local().format('h:mm:ss a'));
            }
        }
    };

    ko.bindingHandlers.enterKey = {
        init: function (element, valueAccessor, allBindings, vm) {
            ko.utils.registerEventHandler(element, "keydown", function (event) {
                if (event.keyCode === 13) {
                    ko.utils.triggerEvent(element, "change");
                    valueAccessor().call(vm, vm);
                }
                return true;
            });
        }
    };

    //message mapping function
    function Message(m) {
        this.messageId = m.MessageId;
        this.connectionId = m.ConnectionId;
        this.messageText = m.MessageText;
        this.messageDate = m.MessageDate;
        this.authorName = m.AuthorName;
        this.roomId = m.RoomId;

        //this.cssName = m.MessageText.toLowerCase().indexOf(chatHub.state.username.toLowerCase()) !== -1 ? "ChatMessage ChatMentioned dnnClear" : "ChatMessage dnnClear";
        //patch from @briandukes to highlight your own posts
        this.cssName = "ChatMessage dnnClear";
        if (checkMention(m.MessageText, chatHub.state.username)) {
            this.cssName += " ChatMentioned";
        }
        if (m.AuthorName === chatHub.state.username) {
            this.cssName += " ChatSelf";
        }
        
        //TODO: not sure what this was for?
        this.targetMessageAuthor = function () {
            //$('#msg').val($('#msg').val() + ' @' + $(this).text() + ' ').focus();

            var parentRoom = findRoom(m.roomId);
            if (parentRoom) {
                alert('parent text: ' + parentRoom.newMessageText());
            }

            //parent.newMessageText().(parent.newMessageText() + ' @' + this.authorName + ' ').focus();
        };
    }

    var messageModel = {
        messages: ko.observableArray([])
    };

    //used for the list of rooms
    var roomModel = {
        rooms: ko.observableArray([]),
        ShowLobby: function () {
            //get an updated list of rooms for the Lobby
            chatHub.server.getLobby();
            
            //open the lobby dialog
            $(".LobbyRoomList").dialog({
                width: '600px',
                modal: true
                , dialogClass: "dnnFormPopup"
            });
        },
        HideLobby: function () {
            $(".LobbyRoomList").hide();
        }
    };

    //used to manage which rooms a user is in
    var userRoomModel = {
        rooms: ko.observableArray([])
        , activeRoom: ko.observable(activeRoomId)
    };


    //Room mapping function
    function Room(r) {
        this.roomId = r.RoomId;
        this.roomName = r.RoomName;
        this.roomDescription = r.RoomDescription;
        //this is used to be able to "scroll" properly when a new message comes in, need to be able to know what the outer div is, it is this id
        this.roomNameId = "room-" + r.RoomId;
        
        this.messages = ko.observableArray([]);
        this.connectionRecords = ko.observableArray([]);

        this.awayMessageCount = ko.observable(0);
        this.awayMentionCount = ko.observable(0);

        this.formattedAwayMessageCount = ko.computed(function () {
            return "(" + this.awayMessageCount + ")";
        }, this);

        this.formattedAwayMentionCount = ko.computed(function () {
            return '(' + this.awayMentionCount + ')';
        }, this);
        
        //add a message without parsing
        this.addSystemMessage = function (m) {
            this.messages.push(m);
        }.bind(this);

        this.addMessage = function (m) {
            this.messages.push(replaceMessage(m));

            //check if this is the current room
            //TODO: also check if focus
            if (!this.showRoom()) {
                this.awayMessageCount(this.awayMessageCount() + 1);
                if (checkMention(m.messageText, chatHub.state.username)) {
                    this.awayMentionCount(this.awayMentionCount() + 1);
                }
            } else {
                //only scroll if the room is currently visible
                var parentDiv = "#" + this.roomNameId;

                if ($(parentDiv).scrollTop() + $(parentDiv).height() < $(parentDiv)[0].scrollHeight - 250) {
                    //pause
                } else {
                    $(parentDiv).scrollTop($(parentDiv)[0].scrollHeight);
                }

            }            
        }.bind(this);

        this.addConnectionRecord = function (cr) {
            this.connectionRecords.push(cr);
        }.bind(this);

        this.removeConnectionRecords = function () {
            this.connectionRecords.removeAll();
        };

        //this.visible = ko.observable(true);

        this.addOnEnter = function (event) {
            var keyCode = (event.which ? event.which : event.keyCode);
            if (keyCode === 13) {
                this.sendMessage();
                return false;
            }
            return true;
        };

        this.setActiveRoom = function () {
            userRoomModel.activeRoom(this.roomId);
            this.awayMessageCount(0);
            this.awayMentionCount(0);
        };


        this.showRoom = ko.computed(function () {
            return this.roomId === userRoomModel.activeRoom();
        }, this);

        //clear out the message text to start
        this.newMessageText = ko.observable("");

        this.sendMessage = function () {
            //remove all HTML tags first for safety
            var msgSend = $.trim(this.newMessageText().replace(/(<([^>]+)>)/ig, ""));

            //make sure the chat string isn't empty
            if (msgSend != '') {

                // Call the chat method on the server
                if ($.connection.hub.state === $.connection.connectionState.connected) {
                    //console.log("connected");
                    chatHub.server.send(msgSend, this.roomId);
                    //clear the textbox for the next message
                    this.newMessageText('');

                    showStatus(stateConnected);
                } else if ($.connection.hub.state === $.connection.connectionState.reconnecting) {
                    chatHub.state.moduleid = moduleid;
                    chatHub.state.userid = userid;
                    chatHub.state.username = username;
                    //start the connection again -should handle this better
                    showStatus(sendMessageReconnecting);
                }
            }
        };

        this.disconnectRoom = function () {
            chatHub.server.leaveRoom(this.roomId, moduleid);
            userRoomModel.rooms.remove(this);
            //TODo: should we send them to a different room?
            userRoomModel.activeRoom(defaultRoomId);
        };

        this.joinRoom = function () {
            //check if the userid >0 otherwise don't let them join
            if (chatHub.state.userid > 0 || this.roomId == defaultRoomId) {
                var foundRoom = findRoom(this.roomId);
                if (!foundRoom) {
                    if (this.roomId != userRoomModel.activeRoom) {
                        chatHub.server.getRoomInfo(this.roomId, moduleid);
                        this.setActiveRoom();
                    }
                    $(".LobbyRoomList").dialog('close');
                } else {
                    alert(alreadyInRoom);
                    $(".LobbyRoomList").dialog('close');
                }
            } else {
                alert(anonUsersRooms);
                $(".LobbyRoomList").dialog('close');
            }
        };
    }

    function findRoom(rId) {
        return ko.utils.arrayFirst(userRoomModel.rooms(), function (room) {
            return room.roomId === rId;
        });
    }

    function formatCount(value) {
        return "$" + value;
    }


    var chatHub = $.connection.chatHub;
    $.connection.hub.logging = false;

    //define the client state with information from DNN, this will get used after the connection starts
    chatHub.state.moduleid = moduleid;
    chatHub.state.userid = userid;
    chatHub.state.username = username;
    chatHub.state.startMessage = startmessage;
    chatHub.state.defaultRoomId = defaultRoomId;

    // Declare a function to actually create a message on the chat hub so the server can invoke it
    chatHub.client.newMessage = function (data) {
        var m = new Message(data);

        //lookup the proper ROOM in the array and push a message to it
        var curRoom = findRoom(m.roomId);
        if (curRoom) {
            curRoom.addMessage(m);
        } else {
            //If the room isn't found display an alert
            alert(messageMissingRoom);
        }

        if (focus === false) {
            //handle new messages if window isn't in focus
            updateUnread(checkMention(m.messageText, chatHub.state.username));
        } 
    };

    chatHub.client.newMessageNoParse = function (data) {

        var m = new Message(data);
        var curRoom = findRoom(m.roomId);
        if (curRoom) {
            curRoom.addSystemMessage(m);
        } else {
            //If the room isn't found display an alert
            alert(messageMissingRoom);
        }
    };

    //TODO: handle state better if a connection is lost

    //wire up the click handler for the button after the connection starts
    this.init = function (element) {
        $.connection.hub.start().done(function () {
            //set the default room?
            //usersViewModel.activeRoom(settings.defaultRoomId);
            //TODO: do anything here?
            //btnSubmit.click();
        });
    };

    //logic below based on code from Jabbr (http://jabbr.net)
    $.connection.hub.stateChanged(function (change) {
        if (change.newState === $.connection.connectionState.reconnecting) {
            //do something on reconnect   
            showStatus(stateReconnecting);
        }
        else if (change.newState === $.connection.connectionState.connected) {
            if (!firstConnection) {
                //do something on subsequent connections

                showStatus(stateReconnected);

            } else {

                //do something else on first connection
                showStatus(stateConnected);
            }
        }
    });
    $.connection.hub.disconnected(function () {

        showStatus(stateDisconnected);

        // Restart the connection
        setTimeout(function () {
            $.connection.hub.start();
        }, 5000);
    });


    chatHub.client.join = function () {
        //fire the connection back to ChatHub that allows us to access the state, and join rooms
        chatHub.server.join();
    };

    //when a connection starts we can't use the "state", the properties defined above, so we have to fire this method after that connection starts
    chatHub.client.populateUser = function (allRooms, myRooms) {
        $.each(allRooms, function (i, item) {
            var r = new Room(item);
            roomModel.rooms.push(r);
        });

        //usersViewModel.connectionRecords.removeAll();
        userRoomModel.rooms.removeAll();
        $.each(myRooms, function (i, item) {
            var r = new Room(item);
            r.joinRoom();
        });

        chatHub.state.startMessage = "";
    };
    

    chatHub.client.fillLobby = function (allRooms) {
        roomModel.rooms.removeAll();
        $.each(allRooms, function (i, item) {
            var r = new Room(item);
            roomModel.rooms.push(r);
        });
    };

    chatHub.client.messageJoin = function (item) {
        var r = new Room(item);
        r.joinRoom();
    };

    chatHub.client.joinRoom = function (item) {
        var r = new Room(item);
        var foundRoom = findRoom(r.roomId);
        if (!foundRoom) {
            userRoomModel.rooms.push(r);
            chatHub.server.joinRoom(r.roomId, moduleid);
        }
    };

    //this method get's called from the Hub when you update your name using the /name SOMETHING call in the text window
    chatHub.client.updateName = function (newName) {
        chatHub.state.username = newName;
    };

    var emoticons = {
        ':-)': 'smiling.png',
        ':)': 'smiling.png',
        '=)': 'smiling.png',
        ';)': 'winking.png',
        ';P': 'winking_tongue_out.png',
        ';D': 'winking_grinning.png',
        ':D': 'grinning.png',
        '=D': 'grinning.png',
        ':P': 'tongue_out.png',
        ':(': 'frowning.png',
        ':\\': 'unsure_2.png',
        ':|': 'tired.png',
        '>:D': 'malicious.png',
        '>:)': 'spiteful.png',
        '(Y)': 'thumbs_up.png',
        '(N)': 'thumbs_down.png'
    }, url = emoticonsUrl, patterns = [],
            metachars = /[[\]{}()*+?.\\|^$\-,&#\s]/g;

    // build a regex pattern for each defined property
    for (var i in emoticons) {
        if (emoticons.hasOwnProperty(i)) { // escape metacharacters
            patterns.push('(' + i.replace(metachars, "\\$&") + ')');
        }
    }

    function replaceMessage(message) {
        //urls
        var exp = /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig;
        message.messageText = message.messageText.replace(exp, "<a href='$1' target='_blank'>$1</a>");

        //emoticons
        message.messageText = message.messageText.replace(new RegExp(patterns.join('|'), 'g'), function (match) {
            return typeof emoticons[match] != 'undefined' ? '<img src="' + url + emoticons[match] + '"/>' : match;
        });

        //check for long string of characters

        return message;
    }

    //take all the users and put them in the view model
    chatHub.client.updateUserList = function (data, roomId) {
        var curRoom = findRoom(roomId);
        if (curRoom) {
            curRoom.removeConnectionRecords();
            $.each(data, function (i, item) {
                var cr = new ConnectionRecord(item);
                //lookup the proper ROOM in the array and push the connection to it
                curRoom.connectionRecords.push(cr);
            });
        }

        //sort the list of users
        usersViewModel.connectionRecords.sort(function (left, right) { return left.authorName == right.authorName ? 0 : (left.authorName.toLowerCase() < right.authorName.toLowerCase() ? -1 : 1); });


        //update the online user count
        //TODO: user counts aren't working
        $('#currentCount').text(data.length);
    };

    //TODO: handle these click events with knockout

    //TODO: userlist should be per room
    //TODO: wire up user list click to the text box
    $('#userList').on('click', '.UserListUser', function () {
        $('#msg').val($('#msg').val() + ' @' + $(this).text() + ' ').focus();
    });

    //TODO: messages need to be per room
    //TODO: wire up the authorname click to the proper text box
    $(".chatMessages").on('click', '.MessageAuthor', function () {
        $('#msg').val($('#msg').val() + ' @' + $(this).text() + ' ').focus();
    });

    function updateUnread(mentioned) {
        if (focus === false) {
            if (mentioned === true)
                mentions = mentions + 1;
            unread = unread + 1;
            SetTitle();
        }
    }

    //TODO: modify the titles of the tabs for each room with notifications
    function SetTitle() {
        if (focus == false) {
            document.title = "(" + unread + ") " + "(" + mentions + ") " + pageTitle;
        } else {
            document.title = pageTitle;
        }
    }

    function checkMention(messageText, un) {
        if (String(messageText).toLowerCase().indexOf(String(un).toLowerCase()) !== -1) {
            {
                return true;
            }
        }
        return false;
    }

    //for autocomplete of usernames look at 
    //http://stackoverflow.com/questions/7537002/autocomplete-combobox-with-knockout-js-template-jquery 


    ko.applyBindings(userRoomModel, document.getElementById('userRoomList'));
    ko.applyBindings(userRoomModel, document.getElementById('roomView'));

    ko.applyBindings(roomModel, document.getElementById('roomList'));
}

/* used to format the counters when a room isn't active */
function formatCount(value) {
    return "(" + value + ")";
}

function showStatus(message) {
    $('#ChatStatus').html(message);
}
