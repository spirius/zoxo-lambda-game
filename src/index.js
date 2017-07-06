const AWS    = require('aws-sdk');
const uuid   = require('uuid');

AWS.config.region = process.env.AWS_REGION;

const dynamodb = new AWS.DynamoDB();

var winPattern = ["xxx......", "...xxx...", "......xxx", "x..x..x..", ".x..x..x.", "..x..x..x", "x...x...x", "..x.x.x.."]
var winPatternRegexps = {"x": [], "o": []}

for (var i in winPattern) {
    var px = winPattern[i];
    var po = px.replace(/x/g, "o")
    winPatternRegexps.x.push({r: new RegExp("^" + px + "$"), p: px})
    winPatternRegexps.o.push({r: new RegExp("^" + po + "$"), p: po})
}

function checkWinner(board) {
    for (var i in winPatternRegexps.x) {
        var p = winPatternRegexps.x[i];

        if (board.match(p.r)) {
            return {
                winner: "x",
                pattern: p.p,
            };
        }

        p = winPatternRegexps.o[i];

        if (board.match(p.r)) {
            return {
                winner: "o",
                pattern: p.p,
            };
        }
    }

    return null
}

function getRequest(event) {
    var res = event.queryStringParameters || {};

    if ((event.httpMethod == "POST" || event.httpMethod == "PUT") && event.headers) {
        var contentType = null;

        for (i in event.headers) {
            if (i.toLowerCase() == "content-type") {
                contentType = event.headers[i].split(";")[0]
                break;
            }
        }

        if (contentType == "application/json") {
            var bodyData = JSON.parse(event.body)

            for (var i in bodyData) {
                res[i] = bodyData[i]
            }
        }
    }

    return res;
}

function marshalGame(game, private) {
    var r = {
        Id: game.Id.S,
        PlayerX: game.PlayerX.S,
        PlayerO: game.PlayerO.S,
        Created: game.Created.S,
    }

    if (!private) {
        r.Board = game.Board.S
    }

    if (game.WinnerId) {
        r.WinnerId = game.WinnerId.S
        r.WinnerPattern = game.WinnerPattern.S
    }

    if (game.Finished) {
        r.Finished = game.Finished.S
    }

    return r
}

function getMyId(event, callback) {
    if (!event.requestContext || !event.requestContext.authorizer || !event.requestContext.authorizer.Id) {
        callback(null, {
            statusCode: 401,
            body: JSON.stringify({
                error: "Unauthorized"
            })
        })
        return null
    }
    return event.requestContext.authorizer.Id
}

exports.list = (event, context, callback) => {
    var dynamoParams = {
        TableName: process.env.ZOXO_DYNAMO_TABLE_GAME,
        IndexName: process.env.ZOXO_DYNAMO_TABLE_GAME_PLAYERO_INDEX,
        KeyConditionExpression: "PlayerO = :dash",
        ExpressionAttributeValues: {
            ":dash": {S: "-"}
        },
        ScanIndexForward: false
    }

    dynamodb.query(dynamoParams, (err, data) => {
        if (err || !data.Items) {
            console.error(err)
            return callback("Unexpected error")
        }

        var res = [];

        for (i in data.Items) {
            var game = data.Items[i]

            res.push(marshalGame(game, true))
        }

        callback(null, {
            statusCode: 200,
            body: JSON.stringify({
                ok: true,
                data: res,
            })
        })
    })
}

exports.get = (event, context, callback) => {
    var myId = getMyId(event, callback)

    var gameId = event.pathParameters && event.pathParameters.id;

    if (!gameId || typeof(gameId) != "string") {
        return callback(null, {
            statusCode: 400,
            body: JSON.stringify({
                error: "Game Id is required"
            })
        })
    }

    var params = {
        Key: {
            Id: {
                S: gameId
            }
        },
        TableName: process.env.ZOXO_DYNAMO_TABLE_GAME
    }

    dynamodb.getItem(params, (err, data) => {
        if (err) {
            console.error(err)
            return callback("Unexpected error")
        }

        if (!data || !data.Item) {
            return callback(null, {
                statusCode: 404,
                body: JSON.stringify({
                    error: "Game not found"
                })
            })
        }

        var game = marshalGame(data.Item, (data.Item.PlayerX.S != myId && data.Item.PlayerO.S != myId));

        callback(null, {
            statusCode: 200,
            body: JSON.stringify({
                ok: true,
                data: game,
            })
        })
    })
}

exports.join = (event, context, callback) => {
    var myId = getMyId(event, callback)

    var request = getRequest(event);

    if (!request.GameId || typeof(request.GameId) != "string") {
        return callback(null, {
            statusCode: 400,
            body: JSON.stringify({
                error: "Game Id is required"
            })
        })
    }

    var params = {
        TableName: process.env.ZOXO_DYNAMO_TABLE_GAME,
        Key: {
            Id: {
                S: request.GameId
            }
        }
    }

    dynamodb.getItem(params, (err, data) => {
        if (err) {
            console.error(err)
            return callback("Unexpected error")
        }

        if (!data || !data.Item) {
            return callback(null, {
                statusCode: 404,
                body: JSON.stringify({
                    error: "Game not found"
                })
            })
        }

        var game = data.Item

        if (game.PlayerX.S == myId) {
            return callback(null, {
                statusCode: 400,
                body: JSON.stringify({
                    error: "Cannot join to own game"
                })
            })
        } else if (game.PlayerO.S != "-") {
            return callback(null, {
                statusCode: 400,
                body: JSON.stringify({
                    error: "Game is not open"
                })
            })
        }

        game.PlayerO.S = myId

        var update = {
            TableName: process.env.ZOXO_DYNAMO_TABLE_GAME,
            Item: game,
            ConditionExpression: "PlayerO = :dash",
            ExpressionAttributeValues: {
                ":dash": {S: "-"}
            },
        }

        dynamodb.putItem(update, (err, data) => {
            if (err && err.code == 'ConditionalCheckFailedException') {
                return callback(null, {
                    statusCode: 400,
                    body: JSON.stringify({
                        error: "Game is not open"
                    })
                })
            } else if (err) {
                console.error(err)
                return callback("Unexpected error")
            }

            callback(null, {
                statusCode: 200,
                body: JSON.stringify({
                    ok: true,
                    data: marshalGame(game),
                })
            })
        })
    })
}

exports.cross = (event, context, callback) => {
    var myId = getMyId(event, callback)

    var request = getRequest(event);

    if (!request.GameId || typeof(request.GameId) != "string") {
        return callback(null, {
            statusCode: 400,
            body: JSON.stringify({
                error: "Game Id is required"
            })
        })
    }

    var x = parseInt(request.CX), y = parseInt(request.CY);

    if (!isFinite(x) || ! isFinite(y) || x < 0 || x >= 9 || y < 0 || y >= 9) {
        return callback(null, {
            statusCode: 400,
            body: JSON.stringify({
                error: "Invalid cross cordinates"
            })
        })
    }

    var params = {
        TableName: process.env.ZOXO_DYNAMO_TABLE_GAME,
        Key: {
            Id: {
                S: request.GameId
            }
        }
    }

    dynamodb.getItem(params, (err, data) => {
        if (err) {
            console.error(err)
            return callback("Unexpected error")
        }

        if (!data || !data.Item) {
            return callback(null, {
                statusCode: 404,
                body: JSON.stringify({
                    error: "Game not found"
                })
            })
        }

        var game = data.Item

        if (game.Finished && game.Finished.S) {
            return callback(null, {
                statusCode: 400,
                body: JSON.stringify({
                    error: "Game has been finished"
                })
            })
        }

        var mySign;

        if (myId == game.PlayerX.S) {
            mySign = "x"
        } else if (myId == game.PlayerO.S) {
            mySign = "o"
        } else {
            return callback(null, {
                statusCode: 404,
                body: JSON.stringify({
                    error: "Game not found"
                })
            })
        }

        var board = game.Board.S

        if (board[y * 3 + x] != "-") {
            return callback(null, {
                statusCode: 400,
                body: JSON.stringify({
                    error: "The point already crossed"
                })
            })
        }

        var counter = {x:0, o:0, "-": 0}

        for (var i in board) {
            counter[board[i]]++
        }

        var turn = counter.x <= counter.o ? "x" : "o"

        if (mySign != turn) {
            return callback(null, {
                statusCode: 400,
                body: JSON.stringify({
                    error: "Its not your turn"
                })
            })
        }

        var b = board.split("");
        b[y * 3 + x] = mySign;
        var newBoard = b.join("")

        game.Board.S = newBoard

        var winner = checkWinner(newBoard);

        if (winner) {
            game.WinnerId = {S: game["Player" + winner.winner.toUpperCase()].S};
            game.WinnerPattern= {S: winner.pattern}
        }

        if (newBoard.indexOf("-") == -1 || winner) {
            game.Finished = {S: (new Date()).toISOString()}
        }

        var update = {
            TableName: process.env.ZOXO_DYNAMO_TABLE_GAME,
            Item: game,
            ConditionExpression: "Board = :board",
            ExpressionAttributeValues: {
                ":board": {S: board}
            },
        }

        dynamodb.putItem(update, (err, data) => {
            if (err && err.code == 'ConditionalCheckFailedException') {
                return callback(null, {
                    statusCode: 400,
                    body: JSON.stringify({
                        error: "Race condition"
                    })
                })
            } else if (err) {
                console.error(err)
                return callback("Unexpected error")
            }

            callback(null, {
                statusCode: 200,
                body: JSON.stringify({
                    ok: true,
                    data: marshalGame(game),
                })
            });
        })
    })
}

exports.create = (event, context, callback) => {
    var myId = getMyId(event, callback)

    var dynamoParams = {
        Item: {
            Id: {
                S: uuid.v4(),
            },
            PlayerX: {
                S: myId,
            },
            PlayerO: {
                S: "-"
            },
            Created: {
                S: (new Date()).toISOString()
            },
            Board: {
                S: (new Array(10)).join("-")
            }
        },
        TableName: process.env.ZOXO_DYNAMO_TABLE_GAME,
    }

    dynamodb.putItem(dynamoParams, (err, data) => {
        if (err) {
            console.error(err)
            return callback(err)
        }

        callback(null, {
            statusCode: 200,
            body: JSON.stringify({
                ok: true,
                data: {
                    Id: dynamoParams.Item.Id.S,
                }
            })
        })
    })
}
