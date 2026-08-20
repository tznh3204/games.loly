const express = require("express");
const fs = require("fs");
const path = require("path");
const { TikTokLiveConnection, WebcastEvent } = require("tiktok-live-connector");

const app = express();
const PORT = 3000;
const ADMIN_CODE = "3204";
const QUESTION_TIME = 15;
const QUESTIONS_FILE = path.join(__dirname, "questions.json");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function readQuestions() {
    try {
        if (!fs.existsSync(QUESTIONS_FILE)) {
            fs.writeFileSync(QUESTIONS_FILE, "[]", "utf8");
            return [];
        }
        const file = fs.readFileSync(QUESTIONS_FILE, "utf8");
        if (!file.trim()) return [];
        const questions = JSON.parse(file);
        return Array.isArray(questions) ? questions : [];
    } catch (error) {
        console.error("questions.json:", error);
        return [];
    }
}

function saveQuestions(questions) {
    fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(questions, null, 2), "utf8");
}

let connection = null;

let liveData = {
    connected: false,
    username: "",
    nickname: "",
    avatar: "",
    roomId: "",
    streamerId: "",
    streamerDisplayId: "",
    streamerSecUid: ""
};

let gameData = {
    started: false,
    finished: false,
    currentIndex: -1,
    currentQuestionId: "",
    currentQuestion: "",
    currentQuestionType: "",
    totalQuestions: 0,
    timeLimit: QUESTION_TIME,
    questionStartedAt: null,
    questionEndsAt: null,
    phase: "waiting",
    questionOrder: [],
    winner: null,
    finalWinner: null,
    scores: {},
    resultMessage: "",
    correctAnswer: "",
    answeredBy: null,
    lastEventAt: null
};

function resetGame() {
    gameData = {
        started: false,
        finished: false,
        currentIndex: -1,
        currentQuestionId: "",
        currentQuestion: "",
        currentQuestionType: "",
        totalQuestions: readQuestions().length,
        timeLimit: QUESTION_TIME,
        questionStartedAt: null,
        questionEndsAt: null,
        phase: "waiting",
        questionOrder: [],
        winner: null,
        finalWinner: null,
        scores: {},
        resultMessage: "",
        correctAnswer: "",
        answeredBy: null,
        lastEventAt: null
    };
}

function normalizeAnswer(value) {
    return String(value || "")
        .normalize("NFKC")
        .trim()
        .toLowerCase()
        .replace(/[\u064B-\u065F\u0670]/g, "")
        .replace(/[أإآ]/g, "ا")
        .replace(/ة/g, "ه")
        .replace(/\s+/g, " ");
}

function publicGameState() {
    let remaining = 0;

    if (gameData.phase === "question" && gameData.questionEndsAt) {
        remaining = Math.max(0, Math.ceil((gameData.questionEndsAt - Date.now()) / 1000));
    }

    if (gameData.phase === "timeup" || gameData.phase === "answered") {
        remaining = 0;
    }

    return {
        ...gameData,
        remainingSeconds: remaining,
        correctAnswer: gameData.phase === "answered" || gameData.phase === "timeup"
            ? gameData.correctAnswer
            : "",
        winner: gameData.winner
    };
}

function finishQuestionByTimeout() {
    if (gameData.phase !== "question") return;

    gameData.phase = "timeup";
    gameData.resultMessage = "انتهى الوقت، لم يجب أحد السؤال.";
    gameData.questionEndsAt = null;
    gameData.lastEventAt = Date.now();

    console.log("TIME UP:", gameData.currentQuestion);
}

function shuffledQuestionOrder(questionCount) {
    const order = Array.from({ length: questionCount }, (_, index) => index);
    for (let index = order.length - 1; index > 0; index -= 1) {
        const randomIndex = Math.floor(Math.random() * (index + 1));
        [order[index], order[randomIndex]] = [order[randomIndex], order[index]];
    }
    return order;
}

function startQuestion(position) {
    const questions = readQuestions();
    const questionIndex = gameData.questionOrder[position];

    if (position < 0 || position >= gameData.questionOrder.length || !questions[questionIndex]) {
        gameData.started = true;
        gameData.finished = true;
        gameData.phase = "finished";
        gameData.currentIndex = gameData.questionOrder.length;
        gameData.currentQuestionId = "";
        gameData.currentQuestion = "";
        gameData.currentQuestionType = "";
        gameData.questionStartedAt = null;
        gameData.questionEndsAt = null;
        gameData.totalQuestions = questions.length;
        gameData.finalWinner = getTopPlayer();
        gameData.resultMessage = gameData.finalWinner
            ? `${gameData.finalWinner.nickname} يعرف البث اكثر (${gameData.finalWinner.totalXp} XP).`
            : "انتهت جميع الأسئلة.";
        return;
    }

    const q = questions[questionIndex];

    gameData.started = true;
    gameData.finished = false;
    gameData.currentIndex = position;
    gameData.currentQuestionId = String(q.id);
    gameData.currentQuestion = q.question;
    gameData.currentQuestionType = q.type;
    gameData.totalQuestions = questions.length;
    gameData.timeLimit = Number(q.timeLimit) > 0 ? Number(q.timeLimit) : QUESTION_TIME;
    gameData.questionStartedAt = Date.now();
    gameData.questionEndsAt = Date.now() + gameData.timeLimit * 1000;
    gameData.phase = "question";
    gameData.winner = null;
    gameData.finalWinner = null;
    gameData.answeredBy = null;
    gameData.resultMessage = "";
    gameData.correctAnswer = q.answer;
    gameData.lastEventAt = Date.now();

    console.log(`QUESTION ${position + 1}/${questions.length}: ${q.question}`);
}

function getTopPlayer() {
    const players = Object.values(gameData.scores);
    if (!players.length) return null;
    return players.sort((a, b) => b.totalXp - a.totalXp)[0];
}

function acceptAnswer(user) {
    if (gameData.phase !== "question") return;

    const questions = readQuestions();
    const questionIndex = gameData.questionOrder[gameData.currentIndex];
    const q = questions[questionIndex];
    if (!q) return;

    const message = normalizeAnswer(user.message);
    const correct = normalizeAnswer(q.answer);

    if (!message || message !== correct) {
        return;
    }

    const playerKey = user.userId || user.username || user.nickname || "unknown";
    const previousScore = gameData.scores[playerKey]?.totalXp || 0;
    const earnedXp = Number(q.xp) > 0 ? Number(q.xp) : 18;
    const player = {
        username: user.username || "",
        nickname: user.nickname || user.username || "مشارك",
        avatar: user.avatar || "",
        totalXp: previousScore + earnedXp
    };
    gameData.scores[playerKey] = player;
    gameData.phase = player.totalXp >= 180 ? "finished" : "answered";
    gameData.finished = player.totalXp >= 180;
    gameData.questionEndsAt = null;
    gameData.winner = {
        ...player,
        message: user.message,
        earnedXp
    };
    gameData.answeredBy = gameData.winner;
    gameData.finalWinner = player.totalXp >= 180 ? player : null;
    gameData.resultMessage = player.totalXp >= 180
        ? `${player.nickname} يعرف البث اكثر (${player.totalXp} XP).`
        : `${player.nickname} جاوب إجابة صحيحة وحصل على ${earnedXp} XP. مجموع نقاطه: ${player.totalXp} XP.`;
    gameData.lastEventAt = Date.now();

    console.log("CORRECT:", gameData.winner);
}

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/administration", (req, res) => res.sendFile(path.join(__dirname, "public", "administration.html")));
app.get("/streamer", (req, res) => res.sendFile(path.join(__dirname, "public", "connect.html")));
app.get("/connect", (req, res) => res.sendFile(path.join(__dirname, "public", "connect.html")));
app.get("/start", (req, res) => res.sendFile(path.join(__dirname, "public", "start.html")));
app.get("/questions", (req, res) => res.sendFile(path.join(__dirname, "public", "questions.html")));
app.get("/winner", (req, res) => res.sendFile(path.join(__dirname, "public", "winner.html")));
app.get("/player", (req, res) => res.sendFile(path.join(__dirname, "public", "player.html")));
app.get("/surprise", (req, res) => res.sendFile(path.join(__dirname, "public", "surprise.html")));

app.get("/api/questions", (req, res) => res.json({ success: true, questions: readQuestions() }));
app.post("/api/admin/verify", (req, res) => {
    if (String(req.body.code || "") !== ADMIN_CODE) {
        return res.status(403).json({ success: false, message: "رمز الإدارة غير صحيح." });
    }
    res.json({ success: true });
});

app.post("/api/questions", (req, res) => {
    if (String(req.body.code || "") !== ADMIN_CODE) {
        return res.status(403).json({ success: false, message: "رمز الإدارة غير صحيح." });
    }

    const type = String(req.body.type || "").trim();
    const question = String(req.body.question || "").trim();
    const answer = String(req.body.answer || "").trim();

    if (!question) return res.status(400).json({ success: false, message: "اكتب السؤال." });
    if (!answer) return res.status(400).json({ success: false, message: "اكتب الإجابة." });

    let finalType;
    if (type === "followers" || type === "about_loly") finalType = "followers";
    else if (type === "loly" || type === "about_family") finalType = "loly";
    else return res.status(400).json({ success: false, message: "نوع السؤال غير صحيح." });

    const questions = readQuestions();
    const newQuestion = {
        id: Date.now().toString(),
        type: finalType,
        question,
        answer,
        xp: 18,
        timeLimit: QUESTION_TIME,
        createdAt: new Date().toISOString()
    };
    questions.push(newQuestion);
    saveQuestions(questions);
    gameData.totalQuestions = questions.length;

    res.json({ success: true, message: "تمت إضافة السؤال.", question: newQuestion });
});

app.post("/api/questions/update/:id", (req, res) => {
    if (String(req.body.code || "") !== ADMIN_CODE) {
        return res.status(403).json({ success: false, message: "رمز الإدارة غير صحيح." });
    }

    const type = String(req.body.type || "").trim();
    const question = String(req.body.question || "").trim();
    const answer = String(req.body.answer || "").trim();
    const finalType = type === "followers" || type === "about_loly"
        ? "followers"
        : type === "loly" || type === "about_family"
            ? "loly"
            : "";

    if (!question || !answer) {
        return res.status(400).json({ success: false, message: "أكمل السؤال والإجابة." });
    }
    if (!finalType) return res.status(400).json({ success: false, message: "نوع السؤال غير صحيح." });

    const questions = readQuestions();
    const index = questions.findIndex(item => String(item.id) === String(req.params.id));
    if (index === -1) return res.status(404).json({ success: false, message: "السؤال غير موجود." });

    questions[index] = {
        ...questions[index],
        type: finalType,
        question,
        answer,
        timeLimit: Number(req.body.timeLimit) > 0 ? Number(req.body.timeLimit) : QUESTION_TIME
    };
    saveQuestions(questions);
    gameData.totalQuestions = questions.length;

    res.json({ success: true, message: "تم تحديث السؤال.", question: questions[index] });
});

app.post("/api/questions/add", (req, res) => {
    if (String(req.body.code || "") !== ADMIN_CODE) {
        return res.status(403).json({ success: false, message: "رمز الإدارة غير صحيح." });
    }

    const type = String(req.body.type || "").trim();
    const question = String(req.body.question || "").trim();
    const answer = String(req.body.answer || "").trim();

    if (!question || !answer) {
        return res.status(400).json({ success: false, message: "أكمل السؤال والإجابة." });
    }

    const finalType = type === "about_loly" ? "followers" : type === "about_family" ? "loly" : "";
    if (!finalType) return res.status(400).json({ success: false, message: "نوع السؤال غير صحيح." });

    const questions = readQuestions();
    const newQuestion = {
        id: Date.now().toString(),
        type: finalType,
        question,
        answer,
        xp: 18,
        timeLimit: QUESTION_TIME,
        createdAt: new Date().toISOString()
    };
    questions.push(newQuestion);
    saveQuestions(questions);
    gameData.totalQuestions = questions.length;

    res.json({ success: true, question: newQuestion });
});

app.post("/api/questions/delete", (req, res) => {
    if (String(req.body.code || "") !== ADMIN_CODE) {
        return res.status(403).json({ success: false, message: "رمز الإدارة غير صحيح." });
    }

    const id = String(req.body.id || "");
    const old = readQuestions();
    const updated = old.filter(q => String(q.id) !== id);

    if (updated.length === old.length) {
        return res.status(404).json({ success: false, message: "السؤال غير موجود." });
    }

    saveQuestions(updated);
    gameData.totalQuestions = updated.length;
    res.json({ success: true, message: "تم حذف السؤال." });
});

app.post("/api/live/connect", async (req, res) => {
    const username = String(req.body.username || "").trim().replace(/^@/, "");
    if (!username) return res.json({ success: false, message: "اكتب يوزر TikTok." });

    try {
        if (connection) {
            try { await connection.disconnect(); } catch {}
            connection = null;
        }

        resetGame();

        connection = new TikTokLiveConnection(username, { processInitialData: false });
        const state = await connection.connect();

        let nickname = "";
        let avatar = "";
        let streamerId = "";
        let streamerDisplayId = "";
        let streamerSecUid = "";

        try {
            const owner = connection.roomInfo?.owner;
            if (owner) {
                nickname = owner.nickname || "";
                avatar = owner.avatarThumb?.urlList?.[0] || "";
                streamerId = String(owner.id || owner.idStr || "");
                streamerDisplayId = owner.displayId || "";
                streamerSecUid = owner.secUid || "";
            }
        } catch {}

        if (!streamerDisplayId) streamerDisplayId = username;

        liveData = {
            connected: true,
            username,
            nickname,
            avatar,
            roomId: state.roomId,
            streamerId,
            streamerDisplayId,
            streamerSecUid
        };

        connection.on(WebcastEvent.CHAT, data => {
            const user = data?.user || {};
            const chatUsername = user.displayId || "";
            const chatNickname = user.nickname || "";
            const message = String(data?.content || "").trim();
            const chatAvatar = user.avatarThumb?.urlList?.[0] || "";
            const chatUserId = String(user.id || user.idStr || "");
            const chatSecUid = user.secUid || "";

            const isStreamer =
                (liveData.streamerId && chatUserId && liveData.streamerId === chatUserId) ||
                (liveData.streamerDisplayId && chatUsername &&
                    liveData.streamerDisplayId.toLowerCase() === chatUsername.toLowerCase()) ||
                (liveData.streamerSecUid && chatSecUid && liveData.streamerSecUid === chatSecUid);

            const participant = {
                userId: chatUserId,
                username: chatUsername,
                nickname: chatNickname,
                avatar: chatAvatar,
                message,
                isStreamer
            };

            console.log(`${isStreamer ? "STREAMER" : "CHAT"} @${chatUsername}: ${message}`);
            acceptAnswer(participant);
        });

        connection.on("disconnected", () => { liveData.connected = false; });
        connection.on("streamEnd", () => { liveData.connected = false; });
        connection.on("error", error => console.error("TikTok Error:", error));

        res.json({
            success: true,
            username,
            nickname,
            avatar,
            roomId: state.roomId
        });
    } catch (error) {
        console.error("Connect error:", error);
        connection = null;
        liveData = {
            connected: false, username: "", nickname: "", avatar: "",
            roomId: "", streamerId: "", streamerDisplayId: "", streamerSecUid: ""
        };
        res.json({ success: false, message: "لم يتم العثور على بث مباشر لهذا الحساب." });
    }
});

app.get("/api/live/status", (req, res) => res.json({ success: true, live: liveData }));

app.get("/api/game/state", (req, res) => {
    if (gameData.phase === "question" && gameData.questionEndsAt && Date.now() >= gameData.questionEndsAt) {
        finishQuestionByTimeout();
    }
    res.json({ success: true, game: publicGameState() });
});

app.post("/api/game/start", (req, res) => {
    const questions = readQuestions();
    if (!questions.length) {
        return res.status(400).json({ success: false, message: "لا توجد أسئلة." });
    }
    gameData.questionOrder = shuffledQuestionOrder(questions.length);
    startQuestion(0);
    res.json({ success: true, game: publicGameState() });
});

app.post("/api/game/next", (req, res) => {
    if (!gameData.started) {
        return res.status(400).json({ success: false, message: "اللعبة لم تبدأ." });
    }

    if (gameData.phase === "question") {
        return res.status(400).json({ success: false, message: "لا يمكن الانتقال قبل انتهاء السؤال أو الإجابة الصحيحة." });
    }

    if (gameData.finished || gameData.currentIndex + 1 >= gameData.questionOrder.length) {
        gameData.finished = true;
        gameData.phase = "finished";
        gameData.finalWinner = getTopPlayer();
        gameData.currentQuestion = "";
        gameData.currentQuestionId = "";
        gameData.questionStartedAt = null;
        gameData.questionEndsAt = null;
        gameData.resultMessage = gameData.finalWinner
            ? `${gameData.finalWinner.nickname} يعرف البث اكثر (${gameData.finalWinner.totalXp} XP).`
            : "انتهت جميع الأسئلة.";
        return res.json({ success: true, game: publicGameState() });
    }

    startQuestion(gameData.currentIndex + 1);
    res.json({ success: true, game: publicGameState() });
});

app.post("/api/game/reset", (req, res) => {
    resetGame();
    res.json({ success: true, game: publicGameState() });
});

app.get("/api/game/questions", (req, res) => {
    res.json({
        success: true,
        questions: readQuestions().map(q => ({
            id: q.id,
            type: q.type,
            question: q.question,
            xp: q.xp,
            timeLimit: q.timeLimit || QUESTION_TIME
        }))
    });
});

setInterval(() => {
    if (gameData.phase === "question" && gameData.questionEndsAt && Date.now() >= gameData.questionEndsAt) {
        finishQuestionByTimeout();
    }
}, 250);

app.listen(PORT, () => {
    resetGame();
    console.log(`TikTok LIVE GAME running on http://localhost:${PORT}`);
    console.log(`Player: http://localhost:${PORT}/player`);
    console.log(`Streamer: http://localhost:${PORT}/streamer`);
});
