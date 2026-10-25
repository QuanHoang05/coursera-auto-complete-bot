
// ==UserScript==
// @name         Coursera Auto-Learn v6.3 (Smart Navigation & Auto Stop)
// @namespace    http://tampermonkey.net/
// @version      6.3
// @description  Auto video, reading, widget completion, smart navigation and timeout stop.
// @author       QuanHoang Adapted
// @match        https://www.coursera.org/learn/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        watchTimeBeforeSeek: 60,
        playbackSpeed: 2.0,
        skipAssessments: true,
        intervalMs: 2000,

        // Dừng nếu đã chờ 60 giây mà URL không chuyển sang bài mới
        nextItemTimeoutMs: 60_000,

        // Nếu chưa tìm thấy nút Next, thử tìm lại mỗi 5 giây
        navigationRetryMs: 5000,

        // Chờ Coursera cập nhật trạng thái sau khi video kết thúc
        videoCompletionCheckMs: 4000,

        // Chờ Coursera lưu trạng thái sau khi nhấn Complete
        completeClickDelayMs: 3000
    };

    let isRunning = true;
    let lastActionTime = 0;
    let currentUrl = '';
    let pageEnterTime = Date.now();

    // Trạng thái điều hướng
    let waitingForNavigation = false;
    let navigationWaitStartedAt = null;
    let navigationLastSearchAt = 0;
    let navigationClickAttempted = false;
    let navigationReason = '';

    let videoState = {
        hasSeeked: false,
        seekRejected: false,
        resumeTime: 0,
        verifyingTick: false
    };

    let readingState = {
        clickedComplete: false
    };

    // --------------------------------------------------
    // HUD
    // --------------------------------------------------

    function createHUD() {
        if (document.getElementById('coursera-bot-hud')) return;

        const hud = document.createElement('div');
        hud.id = 'coursera-bot-hud';

        hud.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 999999;
            background: #111827;
            color: #fff;
            padding: 12px 16px;
            border-radius: 8px;
            font-family: sans-serif;
            font-size: 13px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.5);
            border: 1px solid #374151;
            min-width: 280px;
            max-width: 340px;
        `;

        hud.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <strong style="color:#10b981;">⚡ Coursera AutoBot v6.3</strong>
                <button id="bot-toggle-btn"
                    style="background:#10b981;color:#fff;border:none;padding:3px 8px;border-radius:4px;cursor:pointer;font-weight:bold;">
                    ĐANG BẬT
                </button>
            </div>

            <div id="bot-status-text"
                style="color:#e5e7eb;font-size:12px;margin-bottom:6px;line-height:1.5;">
                Đang khởi động...
            </div>

            <div style="font-size:11px;color:#9ca3af;border-top:1px solid #374151;padding-top:6px;">
                Điều hướng thông minh · Tự dừng sau 60 giây không chuyển bài
            </div>
        `;

        document.body.appendChild(hud);

        const toggleBtn = document.getElementById('bot-toggle-btn');

        toggleBtn.addEventListener('click', () => {
            isRunning = !isRunning;

            toggleBtn.textContent = isRunning ? 'ĐANG BẬT' : 'ĐÃ TẮT';
            toggleBtn.style.background = isRunning
                ? '#10b981'
                : '#ef4444';

            updateStatus(
                isRunning
                    ? '▶️ Bot tiếp tục hoạt động...'
                    : '⏸️ Bot đã tạm dừng.'
            );
        });
    }

    function updateStatus(msg) {
        const el = document.getElementById('bot-status-text');

        if (el) {
            el.textContent = msg;
        }

        console.log('[Coursera Bot v6.3]:', msg);
    }

    function stopBotOnFinish(reason) {
        isRunning = false;
        waitingForNavigation = false;
        navigationWaitStartedAt = null;
        navigationClickAttempted = false;

        const toggleBtn = document.getElementById('bot-toggle-btn');

        if (toggleBtn) {
            toggleBtn.textContent = 'ĐÃ DỪNG';
            toggleBtn.style.background = '#6b7280';
        }

        updateStatus(reason);
    }

    // --------------------------------------------------
    // Nhận biết chuyển bài
    // --------------------------------------------------

    function resetNavigationState() {
        waitingForNavigation = false;
        navigationWaitStartedAt = null;
        navigationLastSearchAt = 0;
        navigationClickAttempted = false;
        navigationReason = '';
    }

    function checkUrlChange() {
        const newUrl = window.location.href;

        if (newUrl !== currentUrl) {
            const isFirstCheck = currentUrl === '';

            currentUrl = newUrl;
            pageEnterTime = Date.now();

            videoState = {
                hasSeeked: false,
                seekRejected: false,
                resumeTime: 0,
                verifyingTick: false
            };

            readingState = {
                clickedComplete: false
            };

            resetNavigationState();

            if (!isFirstCheck) {
                updateStatus('📄 Phát hiện URL mới. Bắt đầu xử lý bài tiếp theo...');
            }
        }
    }

    function safeClick(el, reason = '') {
        if (!el || el.disabled) return false;

        const now = Date.now();

        if (now - lastActionTime < 1500) {
            return false;
        }

        lastActionTime = now;

        if (reason) {
            updateStatus(reason);
        }

        el.scrollIntoView({
            behavior: 'smooth',
            block: 'center'
        });

        el.click();
        return true;
    }

    function findButtonByText(textArray, container = document) {
        const elements = container.querySelectorAll(
            'button, a[role="button"], div[role="button"]'
        );

        for (const el of elements) {
            if (el.offsetParent === null) continue;

            const text = (
                el.innerText || el.textContent || ''
            ).trim().toLowerCase();

            const aria = (
                el.getAttribute('aria-label') || ''
            ).trim().toLowerCase();

            for (const keyword of textArray) {
                const kw = keyword.toLowerCase();

                if (
                    text === kw ||
                    text.includes(kw) ||
                    aria.includes(kw)
                ) {
                    return el;
                }
            }
        }

        return null;
    }

    // --------------------------------------------------
    // Kiểm tra trạng thái hoàn thành
    // --------------------------------------------------

    function isCurrentItemCompleted() {
        const currentPath = window.location.pathname;

        const sidebarLinks = document.querySelectorAll(
            'a[data-test="rc-ItemLink"], nav a[href*="/learn/"]'
        );

        for (const link of sidebarLinks) {
            const href = link.getAttribute('href');

            if (!href) continue;

            let linkPath;

            try {
                linkPath = new URL(
                    href,
                    window.location.origin
                ).pathname;
            } catch {
                continue;
            }

            if (linkPath !== currentPath) continue;

            const itemText = (
                link.innerText || link.textContent || ''
            ).toLowerCase();

            const itemHtml = link.innerHTML.toLowerCase();

            const ariaLabel = (
                link.getAttribute('aria-label') || ''
            ).toLowerCase();

            if (
                itemText.includes('completed') ||
                itemText.includes('đã hoàn thành') ||
                ariaLabel.includes('completed') ||
                ariaLabel.includes('đã hoàn thành') ||
                itemHtml.includes('completed') ||
                link.querySelector(
                    'svg[data-testid*="completed"],' +
                    'svg[aria-label*="Completed"],' +
                    'svg[aria-label*="hoàn thành"],' +
                    '.rc-CompleteIcon'
                )
            ) {
                return true;
            }
        }

        const mainArea = document.querySelector(
            'main, #main-container, .rc-ItemLayout'
        ) || document.body;

        if (
            mainArea.querySelectorAll(
                '[data-testid="completed-badge"],' +
                '[data-e2e="completed-badge"]'
            ).length > 0
        ) {
            return true;
        }

        return false;
    }

    function isCourseDashboardPage() {
        return /\/(home|grades|discussions|supplement-landing|coursera-plus)\b/i
            .test(window.location.href);
    }

    function isLectureVideoPage() {
        return /\/lecture\//i.test(window.location.href);
    }

    function isWidgetOrPluginPage() {
        return /\/(ungradedWidget|ungradedLab|supplement|dialogue)\//i
            .test(window.location.href);
    }

    function isGradedAssessmentPage() {
        if (
            /\/(exam|quiz|assignment-submission|peer|gradedLti)\//i
                .test(window.location.href)
        ) {
            return true;
        }

        const startQuizBtn = findButtonByText([
            'start assignment',
            'start quiz',
            'resume quiz',
            'try again',
            'bắt đầu bài tập',
            'tiếp tục làm bài',
            'làm lại'
        ]);

        return Boolean(startQuizBtn);
    }

    function isReadingContentLoaded() {
        const spinner = document.querySelector(
            '[data-testid="loading-spinner"],' +
            '.rc-LoadingSpinner,' +
            '[role="progressbar"]'
        );

        if (spinner && spinner.offsetParent !== null) {
            return false;
        }

        const contentContainer = document.querySelector(
            '.rc-CML, .rc-Supplement, [data-testid="cml-viewer"], main article, main'
        );

        if (
            contentContainer &&
            (contentContainer.innerText || '').trim().length > 50
        ) {
            return true;
        }

        if (
            isWidgetOrPluginPage() &&
            document.querySelector(
                'button[data-testid="mark-complete"],' +
                'button[data-e2e="mark-complete-button"]'
            )
        ) {
            return true;
        }

        return false;
    }

    // --------------------------------------------------
    // Điều hướng bài tiếp theo
    // --------------------------------------------------

    function findNextItemButton() {
        const selectors = [
            'button[data-e2e="next-item-link"]',
            'a[data-e2e="next-item-link"]',
            'button[aria-label="Next item"]',
            'button[aria-label="Go to next item"]',
            'a[aria-label="Next item"]'
        ];

        for (const selector of selectors) {
            const el = document.querySelector(selector);

            if (
                el &&
                el.offsetParent !== null &&
                !el.disabled
            ) {
                return el;
            }
        }

        return findButtonByText([
            'go to next item',
            'next item',
            'chuyển đến mục tiếp theo',
            'mục tiếp theo',
            'bài tiếp theo'
        ]);
    }

    function findNextSidebarItem() {
        const sidebarLinks = Array.from(
            document.querySelectorAll(
                'a[data-test="rc-ItemLink"], nav a[href*="/learn/"]'
            )
        );

        const currentPath = window.location.pathname;

        const currentIndex = sidebarLinks.findIndex(link => {
            const href = link.getAttribute('href');

            if (!href) return false;

            try {
                const linkPath = new URL(
                    href,
                    window.location.origin
                ).pathname;

                return linkPath === currentPath;
            } catch {
                return false;
            }
        });

        // Không xác định được bài hiện tại: không suy luận rằng đã hết khóa học.
        if (currentIndex === -1) {
            return {
                foundCurrent: false,
                nextButton: null,
                isLastVisibleItem: false
            };
        }

        if (currentIndex + 1 < sidebarLinks.length) {
            return {
                foundCurrent: true,
                nextButton: sidebarLinks[currentIndex + 1],
                isLastVisibleItem: false
            };
        }

        return {
            foundCurrent: true,
            nextButton: null,
            isLastVisibleItem: true
        };
    }

    function tryNavigateToNextItem() {
        const nextBtn = findNextItemButton();

        if (nextBtn) {
            const clicked = safeClick(
                nextBtn,
                '⏭️ Đã tìm thấy nút Next. Đang chuyển bài...'
            );

            if (clicked) {
                navigationClickAttempted = true;
            }

            return clicked;
        }

        const sidebarResult = findNextSidebarItem();

        if (sidebarResult.nextButton) {
            const clicked = safeClick(
                sidebarResult.nextButton,
                '⏭️ Đang chuyển sang bài tiếp theo qua sidebar...'
            );

            if (clicked) {
                navigationClickAttempted = true;
            }

            return clicked;
        }

        if (!sidebarResult.foundCurrent) {
            updateStatus(
                '🔎 Chưa xác định được bài hiện tại. Tiếp tục tìm bài kế tiếp...'
            );
        } else if (sidebarResult.isLastVisibleItem) {
            updateStatus(
                '🔎 Chưa thấy bài tiếp theo trong danh sách đang hiển thị. Đang chờ và thử lại...'
            );
        }

        return false;
    }

    function goToNextItem(reason = 'Đang tìm bài tiếp theo...') {
        if (waitingForNavigation) return;

        waitingForNavigation = true;
        navigationWaitStartedAt = Date.now();
        navigationLastSearchAt = 0;
        navigationClickAttempted = false;
        navigationReason = reason;

        updateStatus(
            '🔎 ' + reason + ' Nếu không chuyển bài sau 60 giây, bot sẽ tự dừng.'
        );

        tryNavigateToNextItem();
    }

    function handleNavigationWait() {
        if (!waitingForNavigation) return false;

        const now = Date.now();
        const elapsed = now - navigationWaitStartedAt;

        // Đặt timeout trước khi return để bot không bị kẹt vô thời hạn.
        if (elapsed >= CONFIG.nextItemTimeoutMs) {
            stopBotOnFinish(
                '⏹️ Đã chờ 60 giây nhưng URL chưa chuyển sang bài mới. Bot tự dừng để tránh chạy vô hạn. Hãy kiểm tra trang Coursera.'
            );

            return true;
        }

        // Nếu đã click Next, chờ trang chuyển URL.
        // Không click lặp lại vì có thể vô tình bỏ qua nhiều bài.
        if (navigationClickAttempted) {
            const remaining = Math.ceil(
                (CONFIG.nextItemTimeoutMs - elapsed) / 1000
            );

            updateStatus(
                `⏳ Đang chờ Coursera mở bài tiếp theo... Còn ${remaining}s trước khi tự dừng.`
            );

            return true;
        }

        // Chưa tìm thấy nút Next thì tìm lại định kỳ.
        if (
            now - navigationLastSearchAt >=
            CONFIG.navigationRetryMs
        ) {
            navigationLastSearchAt = now;

            tryNavigateToNextItem();
        }

        const remaining = Math.ceil(
            (CONFIG.nextItemTimeoutMs - elapsed) / 1000
        );

        updateStatus(
            `🔎 Đang tìm bài tiếp theo... Còn ${remaining}s trước khi tự dừng.`
        );

        return true;
    }

    // --------------------------------------------------
    // Bộ điều khiển chính
    // --------------------------------------------------

    function runBot() {
        createHUD();
        checkUrlChange();

        if (!isRunning) return;

        // Phải kiểm tra timeout trước khi xử lý waitingForNavigation.
        if (handleNavigationWait()) return;

        if (isCourseDashboardPage()) {
            updateStatus(
                '🏠 Đang ở trang tổng quan. Mở một bài học để bắt đầu.'
            );

            return;
        }

        const timeOnPageSec = Math.round(
            (Date.now() - pageEnterTime) / 1000
        );

        // Bài đã hoàn thành: chuyển tiếp và bắt đầu bộ đếm 60 giây.
        if (
            timeOnPageSec >= 2 &&
            !videoState.verifyingTick &&
            isCurrentItemCompleted()
        ) {
            goToNextItem(
                'Bài hiện tại đã hoàn thành. Đang tìm bài kế tiếp...'
            );

            return;
        }

        // --------------------------------------------------
        // Bài tập tính điểm
        // --------------------------------------------------

        if (isGradedAssessmentPage()) {
            if (CONFIG.skipAssessments) {
                goToNextItem(
                    'Gặp bài tập tính điểm. Đang tìm mục tiếp theo...'
                );
            } else {
                updateStatus(
                    '📝 Đang dừng tại bài tập tính điểm để bạn tự làm.'
                );
            }

            return;
        }

        // --------------------------------------------------
        // Xử lý video
        // --------------------------------------------------

        const videoElement = document.querySelector('video');

        if (isLectureVideoPage() || videoElement) {
            if (
                !videoElement ||
                isNaN(videoElement.duration) ||
                videoElement.duration === 0
            ) {
                updateStatus(
                    `⏳ Đang chờ video tải dữ liệu (${timeOnPageSec}s)...`
                );

                return;
            }

            const inVideoModal = document.querySelector(
                'div[data-testid="in-video-quiz-modal"],' +
                '.rc-InVideoPrompt,' +
                '.c-quiz-modal,' +
                'div[role="dialog"]'
            );

            if (
                inVideoModal &&
                inVideoModal.offsetParent !== null
            ) {
                updateStatus('❓ Phát hiện câu hỏi trong video...');

                const skipBtn = findButtonByText(
                    ['skip', 'continue', 'resume', 'bỏ qua', 'tiếp tục'],
                    inVideoModal
                );

                if (skipBtn) {
                    safeClick(
                        skipBtn,
                        '⏭️ Đang tiếp tục qua câu hỏi trong video.'
                    );

                    return;
                }

                // Không tự chọn hoặc nộp đáp án cho câu hỏi đánh giá.
                updateStatus(
                    '📝 Cần xử lý câu hỏi trong video trước khi tiếp tục.'
                );

                return;
            }

            if (videoState.verifyingTick) return;

            videoElement.muted = true;

            if (
                videoElement.playbackRate !==
                CONFIG.playbackSpeed
            ) {
                videoElement.playbackRate =
                    CONFIG.playbackSpeed;
            }

            if (
                videoElement.paused &&
                !videoElement.ended
            ) {
                videoElement.play().catch(() => { });
            }

            const cur = videoElement.currentTime;
            const dur = videoElement.duration;

            // Video đã kết thúc hoặc gần đến cuối.
            if (
                videoElement.ended ||
                cur >= dur - 0.8
            ) {
                videoState.verifyingTick = true;

                updateStatus(
                    '⏳ Video đã đến cuối. Đang chờ Coursera cập nhật trạng thái...'
                );

                setTimeout(() => {
                    if (!isRunning) {
                        videoState.verifyingTick = false;
                        return;
                    }

                    // URL có thể đã đổi trong lúc chờ.
                    if (window.location.href !== currentUrl) {
                        videoState.verifyingTick = false;
                        return;
                    }

                    if (isCurrentItemCompleted()) {
                        videoState.verifyingTick = false;

                        goToNextItem(
                            'Video đã hoàn thành. Đang tìm bài kế tiếp...'
                        );

                    } else if (
                        videoState.hasSeeked &&
                        !videoState.seekRejected
                    ) {
                        videoState.seekRejected = true;
                        videoState.verifyingTick = false;

                        const fallbackTime =
                            videoState.resumeTime ||
                            Math.min(
                                CONFIG.watchTimeBeforeSeek,
                                dur * 0.3
                            );

                        updateStatus(
                            `⚠️ Chưa xác nhận hoàn thành sau khi tua. Xem lại từ ${Math.round(fallbackTime)}s...`
                        );

                        videoElement.currentTime = fallbackTime;
                        videoElement.playbackRate =
                            CONFIG.playbackSpeed;

                        videoElement.play().catch(() => { });

                    } else {
                        videoState.verifyingTick = false;

                        goToNextItem(
                            'Đã phát hết video. Đang tìm bài kế tiếp...'
                        );
                    }
                }, CONFIG.videoCompletionCheckMs);

                return;
            }

            // Xem đủ 60 giây rồi thử tua đến cuối.
            if (
                !videoState.seekRejected &&
                !videoState.hasSeeked
            ) {
                if (
                    dur >
                    CONFIG.watchTimeBeforeSeek + 5
                ) {
                    if (cur < CONFIG.watchTimeBeforeSeek) {
                        updateStatus(
                            `▶️ Đang xem 1 phút đầu (x2): ${Math.round(cur)}s / ${CONFIG.watchTimeBeforeSeek}s`
                        );

                        return;
                    }

                    videoState.hasSeeked = true;
                    videoState.resumeTime = cur;

                    videoElement.currentTime = Math.max(
                        cur,
                        dur - 3.5
                    );

                    updateStatus(
                        `⏩ Đã xem đủ 60 giây. Đang thử tua đến cuối video (${Math.round(dur)}s)...`
                    );

                    return;

                } else {
                    updateStatus(
                        `▶️ Video ngắn, phát x2: ${Math.round(cur)}s / ${Math.round(dur)}s`
                    );

                    return;
                }
            }

            const modeLabel = videoState.seekRejected
                ? '🔄 Đang xem lại, không tua (x2)'
                : '▶️ Đang phát video (x2)';

            updateStatus(
                `${modeLabel}: ${Math.round(cur)}s / ${Math.round(dur)}s`
            );

            return;
        }

        // --------------------------------------------------
        // Bài đọc, widget và plugin
        // --------------------------------------------------

        window.scrollTo({
            top: document.body.scrollHeight,
            behavior: 'smooth'
        });

        const mainContainer = document.querySelector(
            'main, .rc-ItemLayout, #main-container'
        );

        if (mainContainer) {
            mainContainer.scrollTop =
                mainContainer.scrollHeight;
        }

        const markCompleteBtn = document.querySelector(
            'button[data-testid="mark-complete"],' +
            'button[data-e2e="mark-complete-button"]'
        ) || findButtonByText([
            'mark as completed',
            'mark as complete',
            'đánh dấu là đã hoàn thành'
        ]);

        if (
            markCompleteBtn &&
            !markCompleteBtn.disabled &&
            !readingState.clickedComplete
        ) {
            const btnText = (
                markCompleteBtn.innerText || ''
            ).trim().toLowerCase();

            if (
                !btnText.includes('tiếp theo') &&
                !btnText.includes('next')
            ) {
                const clicked = safeClick(
                    markCompleteBtn,
                    '✅ Đang nhấn Mark as completed...'
                );

                if (clicked) {
                    readingState.clickedComplete = true;

                    updateStatus(
                        '✅ Đã nhấn Complete. Chờ Coursera lưu rồi tìm bài kế tiếp...'
                    );

                    setTimeout(() => {
                        if (!isRunning) return;

                        if (
                            window.location.href !== currentUrl
                        ) {
                            return;
                        }

                        goToNextItem(
                            'Đã nhấn Complete. Đang tìm bài kế tiếp...'
                        );
                    }, CONFIG.completeClickDelayMs);
                }

                return;
            }
        }

        if (
            !isReadingContentLoaded() &&
            timeOnPageSec < 10
        ) {
            updateStatus(
                `⏳ Đang chờ nội dung tải (${timeOnPageSec}s)...`
            );

            return;
        }

        // Trang phụ không có nút Complete:
        // chờ 5 giây rồi thử chuyển bài.
        if (
            timeOnPageSec >= 5 &&
            !readingState.clickedComplete
        ) {
            goToNextItem(
                'Không thấy nút Complete. Đang tìm bài kế tiếp...'
            );
        }
    }

    // --------------------------------------------------
    // Khởi chạy
    // --------------------------------------------------

    createHUD();

    updateStatus('🚀 Coursera AutoBot v6.3 đã khởi động.');

    setInterval(runBot, CONFIG.intervalMs);

})();
