(function () {
  "use strict";

  var CONFIG_MARKER = "__MENU_ENHANCEMENTS_V1__";
  var STATUS_MARKER_PREFIX = "__ORDER_STATUS_V1__";
  var STATUS_COLLECTION_MARKER = "__ORDER_STATUSES_V2__";
  var CONFIG_STORAGE_KEY = "oliveMenuEnhancementsV1";
  var FAVORITES_KEY = "oliveMenuFavoritesV1";
  var HISTORY_KEY = "oliveMenuOrderHistoryV1";
  var APPLIED_COUPON_KEY = "oliveMenuAppliedCouponV1";
  var ADDRESS_BOOK_KEY = "oliveMenuSavedAddressesV1";
  var SELECTED_ADDRESS_KEY = "oliveMenuSelectedAddressV1";
  var STATUS_SYNC_SIGNATURE_KEY = "oliveMenuStatusSyncSignatureV2";
  var ADMIN_SESSION_KEY = "oliveMenuAdminSessionV2";
  var MAX_HISTORY = 10;
  var MAX_SAVED_ADDRESSES = 12;
  var configMarkerId = 0;
  var statusCollectionMarkerId = 0;
  var statusCollection = { version: 2, orders: {} };
  var statusSaveQueue = Promise.resolve();
  var statusMarkers = {};
  var statusMarkersLoaded = false;
  var trackingRefreshTimer = 0;
  var trackingRefreshPromise = null;
  var trackingRefreshGeneration = 0;
  var TRACKING_REFRESH_MS = 5000;
  var adminConfigDirty = false;
  var favoriteOnly = false;
  var installPromptEvent = null;
  var deepLinkHandled = false;
  var selectedAddressId = "";
  var addressEditId = "";
  var applyingSavedAddress = false;
  var savedAddressRestored = false;
  var deliveryMapInstance = null;
  var deliveryMapMarker = null;
  var deliveryMapSelection = null;
  var pendingAddressType = "home";
  var deliveryAddressSearchResults = [];
  var deliveryAddressSearchCache = {};
  var baseGetOrderTotals = window.getOrderTotals;
  var baseRender = window.render;
  var baseRenderCart = window.renderCart;
  var baseLoadCloudProducts = window.loadCloudProducts;
  var baseOpenAdmin = window.openAdmin;
  var baseSetMenuLanguage = window.setMenuLanguage;
  var baseGsPost = window.gsPost;
  var baseSendWA = window.sendWA;
  var baseCompleteReceipt = window.completeCustomerOrderReceiptFlow;
  var baseUpdateOrderStatus = window.updateOrderStatus;
  var baseRenderOrders = window.renderOrders;
  var baseLoadCloudOrders = window.loadCloudOrders;
  var baseGetGPS = window.getGPS;

  function defaultConfig() {
    return {
      version: 1,
      zones: [],
      timeSlots: [
        "أقرب وقت متاح || Earliest available",
        "10:00 ص - 2:00 م || 10:00 AM - 2:00 PM",
        "4:00 م - 9:00 م || 4:00 PM - 9:00 PM"
      ],
      coupons: [],
      bundles: [],
      branches: [],
      bank: {
        bankName: "بنك أبو ظبي التجاري",
        iban: "AE100030011434864820002",
        beneficiary: "OLIVE BRANCH TRADING L L C"
      }
    };
  }

  function safeJson(key, fallback) {
    try {
      var parsed = JSON.parse(localStorage.getItem(key) || "null");
      return parsed == null ? fallback : parsed;
    } catch (error) {
      return fallback;
    }
  }

  function saveJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {}
  }

  function mergeConfig(value) {
    var base = defaultConfig();
    var source = value && typeof value === "object" ? value : {};
    ["zones", "timeSlots", "coupons", "bundles", "branches"].forEach(function (key) {
      if (Array.isArray(source[key])) base[key] = source[key];
    });
    if (source.bank && typeof source.bank === "object") {
      base.bank = {
        bankName: safe(source.bank.bankName || base.bank.bankName).trim(),
        iban: safe(source.bank.iban || base.bank.iban).replace(/\s+/g, "").toUpperCase(),
        beneficiary: safe(source.bank.beneficiary || base.bank.beneficiary).trim()
      };
    }
    base.version = Number(source.version || 1);
    return base;
  }

  var enhancementConfig = mergeConfig(safeJson(CONFIG_STORAGE_KEY, null));
  window.getBankTransferDetails = function () {
    return Object.assign({}, enhancementConfig.bank || defaultConfig().bank);
  };
  var favorites = safeJson(FAVORITES_KEY, []);
  var appliedCouponCode = String(safeJson(APPLIED_COUPON_KEY, "") || "").toUpperCase();
  selectedAddressId = String(safeJson(SELECTED_ADDRESS_KEY, "") || "");

  function isEnglish() {
    return document.documentElement.lang === "en";
  }

  function text(arabic, english) {
    return isEnglish() ? english : arabic;
  }

  function safe(value) {
    return String(value == null ? "" : value);
  }

  function html(value) {
    if (typeof window.esc === "function") return window.esc(value);
    return safe(value).replace(/[&<>'"]/g, function (character) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        '"': "&quot;"
      }[character];
    });
  }

  function bilingual(value) {
    var parts = safe(value).split(/\s*\|\|\s*|\s+\|\s+/);
    return {
      ar: (parts[0] || "").trim(),
      en: (parts[1] || parts[0] || "").trim()
    };
  }

  function shown(value) {
    var parts = bilingual(value);
    return isEnglish() ? parts.en : parts.ar;
  }

  function normalize(value) {
    return safe(value).trim().toLowerCase().replace(/\s+/g, " ");
  }

  function digits(value) {
    return safe(value).replace(/\D/g, "");
  }

  function todayValue() {
    return dateValueAfterDays(0);
  }

  function dateValueAfterDays(days) {
    var date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + Number(days || 0));
    var month = String(date.getMonth() + 1).padStart(2, "0");
    var day = String(date.getDate()).padStart(2, "0");
    return date.getFullYear() + "-" + month + "-" + day;
  }

  function minimumDeliveryDateValue() {
    return dateValueAfterDays(3);
  }

  function setMinimumDeliveryDate() {
    var dateInput = document.getElementById("deliveryDate");
    if (!dateInput) return;
    var minimum = minimumDeliveryDateValue();
    dateInput.min = minimum;
    if (!dateInput.value || dateInput.value < minimum) dateInput.value = minimum;
  }

  function moneyValue(value) {
    if (typeof window.money === "function") return window.money(value);
    return Number(value || 0).toFixed(2).replace(/\.00$/, "");
  }

  function currentFavorites() {
    return favorites.map(String);
  }

  function isFavorite(productId) {
    return currentFavorites().indexOf(String(productId)) !== -1;
  }

  function saveFavorites() {
    saveJson(FAVORITES_KEY, favorites);
    updateFavoriteButton();
  }

  function orderHistory() {
    var history = safeJson(HISTORY_KEY, []);
    return Array.isArray(history) ? history : [];
  }

  function saveOrderHistory(order) {
    var history = orderHistory().filter(function (item) {
      return String(item.orderNo) !== String(order.orderNo);
    });
    order.savedAt = Date.now();
    history.unshift(order);
    saveJson(HISTORY_KEY, history.slice(0, MAX_HISTORY));
  }

  function savedAddresses() {
    var addresses = safeJson(ADDRESS_BOOK_KEY, []);
    if (!Array.isArray(addresses)) return [];
    return addresses.filter(function (address) {
      return address && safe(address.id) && safe(address.label) && safe(address.area) && safe(address.location);
    }).slice(0, MAX_SAVED_ADDRESSES).map(function (address) {
      return {
        id: safe(address.id),
        label: safe(address.label).trim(),
        area: safe(address.area).trim(),
        location: safe(address.location).trim(),
        updatedAt: Number(address.updatedAt || 0)
      };
    });
  }

  function saveAddresses(addresses) {
    saveJson(ADDRESS_BOOK_KEY, addresses.slice(0, MAX_SAVED_ADDRESSES));
  }

  function selectedSavedAddress() {
    return savedAddresses().find(function (address) {
      return address.id === selectedAddressId;
    }) || null;
  }

  function setSelectedAddressId(value) {
    selectedAddressId = safe(value);
    saveJson(SELECTED_ADDRESS_KEY, selectedAddressId);
  }

  function addressOptionLabel(address) {
    return address.label + " — " + address.area;
  }

  function addressTypeIcon(label) {
    var value = normalize(label);
    if (value.indexOf("بيت") !== -1 || value.indexOf("منزل") !== -1 || value.indexOf("home") !== -1) return "🏠";
    if (value.indexOf("مكتب") !== -1 || value.indexOf("office") !== -1 || value.indexOf("work") !== -1) return "🏢";
    return "📍";
  }

  function addressTypeLabel(type) {
    if (type === "office") return text("المكتب", "Office");
    return text("البيت", "Home");
  }

  function showChosenLocation(url, message) {
    var status = document.getElementById("locationStatus");
    var statusText = document.getElementById("locationStatusText");
    var mapLink = document.getElementById("locationMapLink");
    if (!status || !statusText || !mapLink) return;
    status.hidden = false;
    status.className = "locationStatus";
    statusText.textContent = "✓ " + message;
    mapLink.href = url;
    mapLink.textContent = text("فتح موقع التوصيل على الخريطة", "Open delivery location in Maps");
    mapLink.hidden = false;
  }

  function clearLocationStatus() {
    var status = document.getElementById("locationStatus");
    var mapLink = document.getElementById("locationMapLink");
    if (status) status.hidden = true;
    if (mapLink) mapLink.hidden = true;
  }

  function renderSavedAddressOptions() {
    var select = document.getElementById("savedAddressSelect");
    if (!select) return;
    var addresses = savedAddresses();
    if (selectedAddressId && !addresses.some(function (address) { return address.id === selectedAddressId; })) {
      setSelectedAddressId("");
    }
    select.innerHTML = '<option value="">' + text("عنوان جديد / اختر عنوانًا محفوظًا", "New address / choose a saved address") + "</option>" +
      addresses.map(function (address) {
        return '<option value="' + html(address.id) + '"' + (address.id === selectedAddressId ? " selected" : "") + ">" + html(addressOptionLabel(address)) + "</option>";
      }).join("");
    var quickList = document.getElementById("savedAddressQuickList");
    if (quickList) {
      quickList.innerHTML = addresses.map(function (address) {
        var selected = address.id === selectedAddressId;
        return '<button class="quickAddressCard' + (selected ? " active" : "") + '" type="button" aria-pressed="' + (selected ? "true" : "false") + '" onclick="applySavedDeliveryAddress(\'' + html(address.id) + '\')">' +
          '<span class="quickAddressIcon" aria-hidden="true">' + addressTypeIcon(address.label) + '</span>' +
          '<span class="quickAddressText"><b>' + html(address.label) + '</b><small>' + html(address.area) + '</small></span>' +
          (selected ? '<span class="quickAddressCheck" aria-hidden="true">✓</span>' : "") +
        '</button>';
      }).join("");
      quickList.hidden = !addresses.length;
    }
    var count = document.getElementById("savedAddressCount");
    if (count) {
      count.textContent = addresses.length
        ? addresses.length + text(" عناوين محفوظة", " saved addresses")
        : text("أضف البيت أو المكتب مرة واحدة", "Add home or office once");
    }
    var manageButton = document.getElementById("manageAddressButton");
    if (manageButton) manageButton.hidden = !addresses.length;
  }

  function updateAddressBookVisibility(totals) {
    var section = document.getElementById("customerAddressBook");
    if (section) section.hidden = totals.deliveryType !== "delivery";
  }

  function restoreSelectedAddressIntoCheckout() {
    if (savedAddressRestored) return;
    var address = selectedSavedAddress();
    var areaInput = document.getElementById("area");
    var locationInput = document.getElementById("location");
    if (!areaInput || !locationInput) return;
    savedAddressRestored = true;
    if (!address || areaInput.value || locationInput.value) return;
    applyingSavedAddress = true;
    areaInput.value = address.area;
    locationInput.value = address.location;
    applyingSavedAddress = false;
    showChosenLocation(address.location, text("تم اختيار عنوان «", "Selected “") + address.label + text("» للتوصيل", "” for delivery"));
  }

  function activeZone() {
    var areaInput = document.getElementById("area");
    var value = normalize(areaInput && areaInput.value);
    if (!value) return null;
    return enhancementConfig.zones.find(function (zone) {
      var names = bilingual(zone.name);
      return [names.ar, names.en].some(function (name) {
        var normalizedName = normalize(name);
        return normalizedName && (value === normalizedName || value.indexOf(normalizedName) !== -1);
      });
    }) || null;
  }

  function validCoupon(code) {
    var normalizedCode = safe(code).trim().toUpperCase();
    if (!normalizedCode) return null;
    var coupon = enhancementConfig.coupons.find(function (item) {
      return safe(item.code).trim().toUpperCase() === normalizedCode;
    });
    if (!coupon) return null;
    if (coupon.expires && safe(coupon.expires) < todayValue()) return null;
    return coupon;
  }

  function appliedCoupon(totals) {
    var coupon = validCoupon(appliedCouponCode);
    if (!coupon) return null;
    if (Number(totals.subtotal || 0) < Number(coupon.minimum || 0)) return null;
    return coupon;
  }

  function selectedSchedule() {
    var dateInput = document.getElementById("deliveryDate");
    var slotInput = document.getElementById("deliverySlot");
    return {
      date: dateInput ? dateInput.value : "",
      slot: slotInput ? slotInput.value : ""
    };
  }

  function checkoutMetadata() {
    var totals = window.getOrderTotals();
    var schedule = selectedSchedule();
    var coupon = appliedCoupon(totals);
    var zone = activeZone();
    var address = totals.deliveryType === "delivery" ? selectedSavedAddress() : null;
    return {
      zone: zone ? safe(zone.name) : "",
      deliveryDate: totals.deliveryType === "delivery" ? schedule.date : "",
      deliverySlot: totals.deliveryType === "delivery" ? schedule.slot : "",
      addressLabel: address ? safe(address.label) : "",
      couponCode: coupon ? safe(coupon.code).toUpperCase() : "",
      couponPercent: coupon ? Number(coupon.percent || 0) : 0,
      zoneMinimum: zone ? Number(zone.minimum || 0) : 0
    };
  }

  function checkoutNotesText(metadata) {
    var lines = [];
    if (metadata.addressLabel) lines.push("Saved address: " + metadata.addressLabel);
    if (metadata.deliveryDate) lines.push("Delivery date: " + metadata.deliveryDate);
    if (metadata.deliverySlot) lines.push("Delivery slot: " + shown(metadata.deliverySlot));
    if (metadata.couponCode) lines.push("Coupon: " + metadata.couponCode + " (" + metadata.couponPercent + "%)");
    if (metadata.zone) lines.push("Delivery zone: " + shown(metadata.zone));
    return lines.join(" | ");
  }

  function whatsappExtras(order) {
    var metadata = order.enhancements || {};
    var lines = [];
    if (metadata.addressLabel) {
      lines.push(text("📍 اسم العنوان المحفوظ: ", "📍 Saved address: ") + metadata.addressLabel);
    }
    if (metadata.deliveryDate) {
      lines.push(text("📅 تاريخ التوصيل: ", "📅 Delivery date: ") + metadata.deliveryDate);
    }
    if (metadata.deliverySlot) {
      lines.push(text("🕐 موعد التوصيل: ", "🕐 Delivery time: ") + shown(metadata.deliverySlot));
    }
    if (metadata.couponCode) {
      lines.push(text("🎁 كوبون الخصم: ", "🎁 Coupon: ") + metadata.couponCode + " (" + metadata.couponPercent + "%)");
    }
    var itemNotes = (order.items || []).filter(function (item) {
      return safe(item.note).trim();
    });
    if (itemNotes.length) {
      lines.push("", text("📝 ملاحظات المنتجات:", "📝 Item notes:"));
      itemNotes.forEach(function (item) {
        lines.push("- " + shown(item.name) + ": " + safe(item.note).trim());
      });
    }
    return lines;
  }

  function appendWhatsappText(urlValue, extraLines) {
    if (!urlValue || !extraLines.length) return urlValue;
    try {
      var url = new URL(urlValue);
      var oldText = url.searchParams.get("text") || "";
      url.searchParams.set("text", oldText + "\n\n" + extraLines.join("\n"));
      return url.href;
    } catch (error) {
      return urlValue;
    }
  }

  function injectCustomerUi() {
    var categories = document.getElementById("cats");
    if (categories && !document.getElementById("quickServices")) {
      categories.insertAdjacentHTML("beforebegin",
        '<section id="quickServices" class="quickServices" aria-label="خدمات المنيو">' +
          '<button id="favoritesService" class="quickService" type="button" onclick="toggleFavoriteView()">❤️ <span>المفضلة</span></button>' +
          '<button id="repeatService" class="quickService" type="button" onclick="repeatLastOrder()">🔁 <span>إعادة الطلب</span></button>' +
          '<button id="trackingService" class="quickService" type="button" onclick="openTrackingModal()">🚚 <span>تتبّع الطلب</span></button>' +
          '<button id="branchesService" class="quickService" type="button" onclick="openBranchesModal()">📍 <span>الفروع</span></button>' +
          '<button id="installService" class="quickService" type="button" onclick="installOliveMenu()">📱 <span>تثبيت المنيو</span></button>' +
        '</section><section id="offersStrip" class="offersStrip" aria-label="العروض"></section>');
    }

    if (!document.getElementById("enhancementModal")) {
      document.body.insertAdjacentHTML("beforeend",
        '<div id="enhancementModal" class="modal enhancementModal" role="dialog" aria-modal="true">' +
          '<div class="shade" onclick="closeEnhancementModal()"></div>' +
          '<div class="enhancementDialog"><button class="close" type="button" onclick="closeEnhancementModal()">✕</button>' +
            '<div id="enhancementModalBody"></div>' +
          '</div>' +
        '</div>');
    }

    var areaInput = document.getElementById("area");
    if (areaInput && !document.getElementById("customerAddressBook")) {
      areaInput.insertAdjacentHTML("beforebegin",
        '<section id="customerAddressBook" class="customerAddressBook" hidden>' +
          '<div class="addressBookHead"><div class="addressBookTitleGroup"><h4 id="addressBookTitle">🚚 أين نوصل طلبك؟</h4><span id="savedAddressCount"></span></div>' +
            '<button id="manageAddressButton" class="addressManageLink" type="button" onclick="openSavedAddressManager()" hidden>إدارة</button></div>' +
          '<div id="savedAddressQuickList" class="savedAddressQuickList" hidden></div>' +
          '<select id="savedAddressSelect" class="savedAddressSelect" onchange="applySavedDeliveryAddress(this.value)" hidden aria-hidden="true"></select>' +
          '<button id="chooseMapAddressButton" class="chooseMapAddress" type="button" onclick="openDeliveryMapPicker()">＋ إضافة عنوان توصيل جديد</button>' +
          '<div id="addressBookHint" class="addressBookHint">احفظ أكثر من عنوان واختره بلمسة واحدة.</div>' +
        '</section>');
    }
    if (areaInput && !document.getElementById("deliveryZonesList")) {
      areaInput.setAttribute("list", "deliveryZonesList");
      areaInput.insertAdjacentHTML("afterend", '<datalist id="deliveryZonesList"></datalist>');
    }

    var form = document.querySelector("#drawer .form");
    if (form && !document.getElementById("checkoutExtras")) {
      var sendButton = form.querySelector("button.send");
      var extras =
        '<section id="checkoutExtras" class="checkoutExtras">' +
          '<h4>🚚 <span id="deliveryScheduleTitle">موعد التوصيل والكوبون</span></h4>' +
          '<div id="deliveryScheduleFields">' +
            '<div class="field"><label id="deliveryDateLabel" for="deliveryDate">تاريخ التوصيل</label><input id="deliveryDate" type="date"></div>' +
            '<div class="field"><label id="deliverySlotLabel" for="deliverySlot">الفترة المناسبة</label><select id="deliverySlot"></select></div>' +
          '</div>' +
          '<div id="deliveryMinimumHint" class="deliveryMinimumHint">أقرب موعد توصيل متاح بعد 3 أيام من تاريخ الطلب.</div>' +
          '<div class="field"><label id="couponLabel" for="couponCode">كود الخصم</label>' +
            '<div class="couponLine"><input id="couponCode" type="text" autocomplete="off" placeholder="اكتب الكود">' +
            '<button id="couponApplyButton" type="button" onclick="applyMenuCoupon()">تطبيق</button></div>' +
            '<div id="couponState" class="couponState"></div>' +
          '</div>' +
        '</section>';
      if (sendButton) sendButton.insertAdjacentHTML("beforebegin", extras);
      else form.insertAdjacentHTML("beforeend", extras);
      setMinimumDeliveryDate();
    }
    renderSavedAddressOptions();
    restoreSelectedAddressIntoCheckout();
  }

  function injectAdminUi() {
    var adminSide = document.querySelector("#productsTab .adminSide");
    if (!adminSide || document.getElementById("adminEnhancements")) return;
    adminSide.insertAdjacentHTML("beforeend",
      '<section id="adminEnhancements" class="adminEnhancements">' +
        '<h3>إعدادات المناطق والمواعيد والعروض والفروع</h3>' +
        '<div class="notice">هذه الإعدادات تُحفظ لكل الزبائن على نفس الرابط.</div>' +
        '<h3>مناطق التوصيل</h3><div class="muted">المنطقة • الرسوم • الحد الأدنى</div><div id="zoneConfigRows" class="configRows"></div>' +
        '<button class="secondary addConfigRow" type="button" onclick="addEnhancementRow(\'zone\')">+ إضافة منطقة</button>' +
        '<h3>فترات التوصيل</h3><textarea id="timeSlotsConfig" class="configTextarea" placeholder="كل فترة في سطر، ويمكن كتابة العربي || English"></textarea>' +
        '<h3>بيانات التحويل البنكي</h3><div class="muted">تظهر هذه البيانات للزبون عند اختيار التحويل البنكي.</div>' +
        '<div class="bankAdminConfig">' +
          '<label class="configField"><span>اسم البنك</span><input id="bankNameConfig" placeholder="بنك أبو ظبي التجاري"></label>' +
          '<label class="configField"><span>رقم الآيبان IBAN</span><input id="bankIbanConfig" dir="ltr" placeholder="AE100030011434864820002"></label>' +
          '<label class="configField"><span>اسم المستفيد</span><input id="bankBeneficiaryConfig" dir="ltr" placeholder="OLIVE BRANCH TRADING L L C"></label>' +
        '</div>' +
        '<h3>كوبونات الخصم</h3><div class="muted">سجّل بيانات كل كوبون في الخانات الكبيرة التالية.</div><div id="couponConfigRows" class="configRows couponConfigRows"></div>' +
        '<button class="secondary addConfigRow" type="button" onclick="addEnhancementRow(\'coupon\')">+ إضافة كوبون</button>' +
        '<h3>الباقات المجمعة</h3><div class="muted">اسم الباقة • أرقام المنتجات مفصولة بفاصلة • سعر الباقة</div><div id="bundleConfigRows" class="configRows"></div>' +
        '<button class="secondary addConfigRow" type="button" onclick="addEnhancementRow(\'bundle\')">+ إضافة باقة</button>' +
        '<h3>الفروع ونقاط البيع</h3><div class="muted">يمكنك إضافة أي عدد من الفروع، ولكل فرع اسم وعنوان ورابط خرائط مستقل.</div><div id="branchConfigRows" class="configRows branchConfigRows"></div>' +
        '<button class="secondary addConfigRow branchAddButton" type="button" onclick="addEnhancementRow(\'branch\')">+ إضافة فرع آخر</button>' +
        '<button id="saveEnhancementsButton" class="primary" style="width:100%;margin-top:14px" type="button" onclick="saveMenuEnhancements()">حفظ الإضافات لكل الزبائن</button>' +
      '</section>');
    var enhancementSection = document.getElementById("adminEnhancements");
    if (enhancementSection) {
      enhancementSection.addEventListener("input", function () {
        adminConfigDirty = true;
      });
      enhancementSection.addEventListener("change", function () {
        adminConfigDirty = true;
      });
    }
  }

  function zoneRow(item) {
    item = item || {};
    return '<div class="configRow zoneConfigRow">' +
      '<input class="zoneName" placeholder="أبوظبي || Abu Dhabi" value="' + html(item.name || "") + '">' +
      '<input class="zoneFee" type="number" min="0" step="0.01" placeholder="الرسوم" value="' + html(item.fee == null ? "" : item.fee) + '">' +
      '<input class="zoneMinimum" type="number" min="0" step="0.01" placeholder="الحد الأدنى" value="' + html(item.minimum == null ? "" : item.minimum) + '">' +
      '<button type="button" onclick="removeConfigRow(this)">✕</button></div>';
  }

  function couponRow(item) {
    item = item || {};
    return '<div class="configRow couponConfig couponConfigRow">' +
      '<label class="configField couponCodeField"><span>كود الكوبون</span><input class="couponAdminCode" placeholder="مثال: OLIVE10" value="' + html(item.code || "") + '"></label>' +
      '<label class="configField"><span>نسبة الخصم %</span><input class="couponPercent" type="number" min="1" max="100" step="0.01" placeholder="مثال: 10" value="' + html(item.percent == null ? "" : item.percent) + '"></label>' +
      '<label class="configField"><span>الحد الأدنى للطلب</span><input class="couponMinimum" type="number" min="0" step="0.01" placeholder="مثال: 100 درهم" value="' + html(item.minimum == null ? "" : item.minimum) + '"></label>' +
      '<label class="configField"><span>تاريخ الانتهاء</span><input class="couponExpires" type="date" value="' + html(item.expires || "") + '"></label>' +
      '<button type="button" onclick="removeConfigRow(this)">✕</button></div>';
  }

  function bundleRow(item) {
    item = item || {};
    return '<div class="configRow bundleConfig bundleConfigRow">' +
      '<input class="bundleName" placeholder="باقة البيت || Home Bundle" value="' + html(item.name || "") + '">' +
      '<input class="bundleProducts" placeholder="1001,1002,1003" value="' + html((item.productIds || []).join(",")) + '">' +
      '<input class="bundlePrice" type="number" min="0" step="0.01" placeholder="السعر" value="' + html(item.price == null ? "" : item.price) + '">' +
      '<button type="button" onclick="removeConfigRow(this)">✕</button></div>';
  }

  function branchRow(item) {
    item = item || {};
    return '<div class="configRow branchConfig branchConfigRow">' +
      '<label class="configField"><span>اسم الفرع</span><input class="branchName" placeholder="اسم الفرع || Branch name" value="' + html(item.name || "") + '"></label>' +
      '<label class="configField"><span>عنوان الفرع</span><input class="branchAddress" placeholder="المنطقة والعنوان || Address" value="' + html(item.address || "") + '"></label>' +
      '<label class="configField branchMapField"><span>رابط خرائط Google</span><input class="branchMap" type="url" placeholder="الصق رابط الفرع من خرائط Google" value="' + html(item.map || "") + '"></label>' +
      '<button type="button" onclick="removeConfigRow(this)">✕</button></div>';
  }

  function renderAdminConfig(force) {
    injectAdminUi();
    if (adminConfigDirty && force !== true) return;
    var zoneBox = document.getElementById("zoneConfigRows");
    var couponBox = document.getElementById("couponConfigRows");
    var bundleBox = document.getElementById("bundleConfigRows");
    var branchBox = document.getElementById("branchConfigRows");
    var slots = document.getElementById("timeSlotsConfig");
    var bankName = document.getElementById("bankNameConfig");
    var bankIban = document.getElementById("bankIbanConfig");
    var bankBeneficiary = document.getElementById("bankBeneficiaryConfig");
    if (zoneBox) zoneBox.innerHTML = (enhancementConfig.zones.length ? enhancementConfig.zones : [{}]).map(zoneRow).join("");
    if (couponBox) couponBox.innerHTML = (enhancementConfig.coupons.length ? enhancementConfig.coupons : [{}]).map(couponRow).join("");
    if (bundleBox) bundleBox.innerHTML = (enhancementConfig.bundles.length ? enhancementConfig.bundles : [{}]).map(bundleRow).join("");
    if (branchBox) branchBox.innerHTML = (enhancementConfig.branches.length ? enhancementConfig.branches : [{}]).map(branchRow).join("");
    if (slots) slots.value = enhancementConfig.timeSlots.join("\n");
    if (bankName) bankName.value = enhancementConfig.bank.bankName || "";
    if (bankIban) bankIban.value = enhancementConfig.bank.iban || "";
    if (bankBeneficiary) bankBeneficiary.value = enhancementConfig.bank.beneficiary || "";
  }

  window.addEnhancementRow = function (type) {
    var map = {
      zone: ["zoneConfigRows", zoneRow],
      coupon: ["couponConfigRows", couponRow],
      bundle: ["bundleConfigRows", bundleRow],
      branch: ["branchConfigRows", branchRow]
    };
    var item = map[type];
    var box = item && document.getElementById(item[0]);
    if (box) {
      adminConfigDirty = true;
      box.insertAdjacentHTML("beforeend", item[1]({}));
      var rows = box.querySelectorAll(".configRow");
      var lastRow = rows[rows.length - 1];
      var firstInput = lastRow && lastRow.querySelector("input");
      if (firstInput) firstInput.focus();
    }
  };

  window.removeConfigRow = function (button) {
    var row = button && button.closest(".configRow");
    if (row) {
      adminConfigDirty = true;
      row.remove();
    }
  };

  function collectConfig() {
    var zones = Array.prototype.slice.call(document.querySelectorAll(".zoneConfigRow")).map(function (row) {
      return {
        name: row.querySelector(".zoneName").value.trim(),
        fee: Number(row.querySelector(".zoneFee").value || 0),
        minimum: Number(row.querySelector(".zoneMinimum").value || 0)
      };
    }).filter(function (item) { return item.name; });

    var coupons = Array.prototype.slice.call(document.querySelectorAll(".couponConfigRow")).map(function (row) {
      return {
        code: row.querySelector(".couponAdminCode").value.trim().toUpperCase(),
        percent: Number(row.querySelector(".couponPercent").value || 0),
        minimum: Number(row.querySelector(".couponMinimum").value || 0),
        expires: row.querySelector(".couponExpires").value
      };
    }).filter(function (item) { return item.code && item.percent > 0; });

    var bundles = Array.prototype.slice.call(document.querySelectorAll(".bundleConfigRow")).map(function (row) {
      return {
        name: row.querySelector(".bundleName").value.trim(),
        productIds: row.querySelector(".bundleProducts").value.split(",").map(function (value) {
          return value.trim();
        }).filter(Boolean),
        price: Number(row.querySelector(".bundlePrice").value || 0)
      };
    }).filter(function (item) { return item.name && item.productIds.length && item.price > 0; });

    var branches = Array.prototype.slice.call(document.querySelectorAll(".branchConfigRow")).map(function (row) {
      return {
        name: row.querySelector(".branchName").value.trim(),
        address: row.querySelector(".branchAddress").value.trim(),
        map: row.querySelector(".branchMap").value.trim()
      };
    }).filter(function (item) { return item.name && item.map; });

    var slotValue = document.getElementById("timeSlotsConfig");
    var timeSlots = safe(slotValue && slotValue.value).split(/\r?\n/).map(function (value) {
      return value.trim();
    }).filter(Boolean);

    var bank = {
      bankName: safe(document.getElementById("bankNameConfig") && document.getElementById("bankNameConfig").value).trim() || defaultConfig().bank.bankName,
      iban: safe(document.getElementById("bankIbanConfig") && document.getElementById("bankIbanConfig").value).replace(/\s+/g, "").toUpperCase() || defaultConfig().bank.iban,
      beneficiary: safe(document.getElementById("bankBeneficiaryConfig") && document.getElementById("bankBeneficiaryConfig").value).trim() || defaultConfig().bank.beneficiary
    };

    return mergeConfig({
      version: 2,
      zones: zones,
      timeSlots: timeSlots.length ? timeSlots : defaultConfig().timeSlots,
      coupons: coupons,
      bundles: bundles,
      branches: branches,
      bank: bank
    });
  }

  window.saveMenuEnhancements = function () {
    var button = document.getElementById("saveEnhancementsButton");
    var oldText = button ? button.textContent : "";
    enhancementConfig = collectConfig();
    saveJson(CONFIG_STORAGE_KEY, enhancementConfig);
    if (!window.gsPost || !window.gsUrl || !window.gsUrl()) {
      alert("تعذر الاتصال بقاعدة المنيو.");
      return;
    }
    if (button) {
      button.disabled = true;
      button.textContent = "جاري الحفظ للجميع...";
    }
    window.gsPost({
      action: "saveProduct",
      id: configMarkerId || 0,
      name: CONFIG_MARKER,
      desc: JSON.stringify(enhancementConfig),
      price: "",
      cat: "labneh",
      visible: false,
      imageData: "",
      existingImage: ""
    }).then(function (result) {
      if (!result || !result.ok) throw new Error((result && result.error) || "FAILED");
      return window.loadCloudProducts();
    }).then(function () {
      adminConfigDirty = false;
      refreshEnhancementUi();
      alert("تم حفظ المناطق والمواعيد وبيانات البنك والكوبونات والباقات والفروع لكل الزبائن.");
    }).catch(function (error) {
      alert("تعذر حفظ الإضافات: " + error.message);
    }).then(function () {
      if (button) {
        button.disabled = false;
        button.textContent = oldText || "حفظ الإضافات لكل الزبائن";
      }
    });
  };

  function extractCloudMarkers() {
    var nextProducts = [];
    var foundConfig = null;
    var foundStatusCollection = null;
    statusMarkers = {};
    (window.products || []).forEach(function (product) {
      var name = safe(product.name).trim();
      if (name === CONFIG_MARKER) {
        configMarkerId = Number(product.id || 0);
        try {
          foundConfig = JSON.parse(safe(product.desc) || "{}");
        } catch (error) {}
        return;
      }
      if (name === STATUS_COLLECTION_MARKER) {
        statusCollectionMarkerId = Number(product.id || 0);
        try {
          foundStatusCollection = JSON.parse(safe(product.desc) || "{}");
        } catch (error) {}
        return;
      }
      if (name.indexOf(STATUS_MARKER_PREFIX) === 0) {
        var number = name.slice(STATUS_MARKER_PREFIX.length);
        try {
          statusMarkers[String(number)] = {
            id: Number(product.id || 0),
            data: JSON.parse(safe(product.desc) || "{}")
          };
        } catch (error) {}
        return;
      }
      nextProducts.push(product);
    });
    window.products = nextProducts;
    if (foundConfig) {
      enhancementConfig = mergeConfig(foundConfig);
      saveJson(CONFIG_STORAGE_KEY, enhancementConfig);
    }
    if (foundStatusCollection && foundStatusCollection.orders) {
      statusCollection = foundStatusCollection;
    } else if (!statusCollection || !statusCollection.orders) {
      statusCollection = { version: 2, orders: {} };
    }
    Object.keys(statusCollection.orders || {}).forEach(function (number) {
      statusMarkers[String(number)] = {
        id: statusCollectionMarkerId,
        data: statusCollection.orders[number]
      };
    });
    statusMarkersLoaded = true;
  }

  function cacheCustomerProducts() {
    try {
      localStorage.setItem("oliveMenuProductsCloudV7", JSON.stringify(window.products || []));
    } catch (error) {}
  }

  function renderDeliveryOptions() {
    setMinimumDeliveryDate();
    var dataList = document.getElementById("deliveryZonesList");
    if (dataList) {
      dataList.innerHTML = enhancementConfig.zones.map(function (zone) {
        return '<option value="' + html(shown(zone.name)) + '"></option>';
      }).join("");
    }
    var slot = document.getElementById("deliverySlot");
    if (slot) {
      var old = slot.value;
      slot.innerHTML = enhancementConfig.timeSlots.map(function (value) {
        return '<option value="' + html(value) + '">' + html(shown(value)) + '</option>';
      }).join("");
      if (old) slot.value = old;
    }
    var areaInput = document.getElementById("area");
    if (areaInput) {
      areaInput.placeholder = enhancementConfig.zones.length
        ? text("اختر أو اكتب منطقة التوصيل", "Choose or type delivery area")
        : text("المنطقة / العنوان", "Area / address");
    }
  }

  function renderOffers() {
    var strip = document.getElementById("offersStrip");
    if (!strip) return;
    var cards = [];
    enhancementConfig.coupons.forEach(function (coupon) {
      if (coupon.expires && safe(coupon.expires) < todayValue()) return;
      cards.push('<article class="offerCard"><b>🎁 ' + text("خصم خاص", "Special discount") + " " + html(coupon.percent) + '%</b>' +
        '<span>' + text("استخدم الكود عند إنهاء الطلب", "Use the code at checkout") + '</span>' +
        '<div class="offerCode">' + html(coupon.code) + '</div>' +
        (Number(coupon.minimum || 0) ? '<div class="muted">' + text("للطلبات من ", "For orders from ") + html(moneyValue(coupon.minimum)) + " " + text("درهم", "AED") + '</div>' : '') +
        '</article>');
    });
    enhancementConfig.bundles.forEach(function (bundle, index) {
      cards.push('<article class="offerCard"><b>🧺 ' + html(shown(bundle.name)) + '</b>' +
        '<span>' + text("باقة منتجات مختارة بسعر ", "Selected bundle for ") + html(moneyValue(bundle.price)) + " " + text("درهم", "AED") + '</span>' +
        '<button type="button" onclick="addMenuBundle(' + index + ')">' + text("أضف الباقة للسلة", "Add bundle to cart") + '</button></article>');
    });
    strip.innerHTML = cards.join("");
  }

  window.addMenuBundle = function (index) {
    var bundle = enhancementConfig.bundles[index];
    if (!bundle) return;
    var bundleProducts = bundle.productIds.map(function (id) {
      return (window.products || []).find(function (product) {
        return String(product.id) === String(id);
      });
    });
    if (bundleProducts.some(function (product) { return !product || product.visible === false || product.available === false; })) {
      alert(text("بعض منتجات هذه الباقة غير متوفرة الآن.", "Some products in this bundle are currently unavailable."));
      return;
    }
    var first = bundleProducts[0];
    var bundleId = 970000000 + Number(index || 0);
    var oldQuantity = window.cart[bundleId] ? Number(window.cart[bundleId].qty || 0) : 0;
    window.cart[bundleId] = {
      id: bundleId,
      productId: first.id,
      selectedSizeKey: "bundle",
      isBundle: true,
      bundleProductIds: bundle.productIds.slice(),
      name: bundle.name,
      desc: bundleProducts.map(function (product) { return shown(product.name); }).join("، "),
      image: first.image,
      price: Number(bundle.price || 0),
      visible: true,
      available: true,
      qty: oldQuantity + 1
    };
    window.saveCart();
    window.render();
    window.renderCart();
    window.openCart();
  };

  function productForCard(card, unused) {
    var pick = card.querySelector(".pick");
    var match = safe(pick && pick.getAttribute("onclick")).match(/add\((\d+)\)/);
    if (match) {
      return (window.products || []).find(function (product) {
        return String(product.id) === String(match[1]);
      }) || null;
    }
    var cardName = normalize(card.querySelector(".name") && card.querySelector(".name").textContent);
    var matchIndex = -1;
    unused.some(function (product, index) {
      if (normalize(shown(product.name)) === cardName) {
        matchIndex = index;
        return true;
      }
      return false;
    });
    return matchIndex >= 0 ? unused.splice(matchIndex, 1)[0] : null;
  }

  function augmentProductCards() {
    var cards = Array.prototype.slice.call(document.querySelectorAll("#grid .card"));
    var unused = (window.products || []).filter(function (product) {
      return product.visible !== false;
    }).slice();
    var visibleCount = 0;
    cards.forEach(function (card) {
      var product = productForCard(card, unused);
      if (!product) return;
      card.setAttribute("data-product-id", product.id);
      var picture = card.querySelector(".pic");
      if (picture && !picture.querySelector(".productUtility")) {
        picture.insertAdjacentHTML("beforeend",
          '<div class="productUtility">' +
            '<button class="' + (isFavorite(product.id) ? "favoriteOn" : "") + '" type="button" aria-label="' + text("المفضلة", "Favorite") + '" onclick="toggleProductFavorite(' + Number(product.id) + ',event)">' + (isFavorite(product.id) ? "♥" : "♡") + '</button>' +
            '<button type="button" aria-label="' + text("مشاركة المنتج", "Share product") + '" onclick="shareMenuProduct(' + Number(product.id) + ',event)">↗</button>' +
          '</div>');
      }
      if (product.available === false) {
        var actions = card.querySelector(".actions");
        if (actions && !actions.querySelector(".notifyStock")) {
          actions.insertAdjacentHTML("beforeend", '<button class="notifyStock" type="button" onclick="notifyProductAvailability(' + Number(product.id) + ')">🔔 ' + text("أخبرني عند التوفر", "Tell me when available") + '</button>');
        }
      }
      if (favoriteOnly && !isFavorite(product.id)) {
        card.style.display = "none";
      } else {
        visibleCount += 1;
      }
    });
    var oldEmpty = document.querySelector("#grid .favoriteEmpty");
    if (oldEmpty) oldEmpty.remove();
    if (favoriteOnly && !visibleCount) {
      document.getElementById("grid").insertAdjacentHTML("beforeend", '<div class="favoriteEmpty">❤️ ' + text("لم تحفظ أي منتجات في المفضلة بعد.", "You have not saved any favorites yet.") + '</div>');
    }
    focusDeepLinkedProduct();
  }

  window.toggleProductFavorite = function (productId, event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    var key = String(productId);
    var index = currentFavorites().indexOf(key);
    if (index >= 0) favorites.splice(index, 1);
    else favorites.push(key);
    saveFavorites();
    window.render();
  };

  window.toggleFavoriteView = function () {
    favoriteOnly = !favoriteOnly;
    updateFavoriteButton();
    window.render();
  };

  function updateFavoriteButton() {
    var button = document.getElementById("favoritesService");
    if (!button) return;
    button.classList.toggle("active", favoriteOnly);
    var label = button.querySelector("span");
    if (label) {
      label.textContent = favoriteOnly
        ? text("عرض الكل", "Show all")
        : text("المفضلة", "Favorites") + (favorites.length ? " (" + favorites.length + ")" : "");
    }
  }

  function customerProductUrl(productId) {
    var url = new URL(location.href);
    url.searchParams.delete("owner_access");
    url.searchParams.set("v", "27-customer-final");
    url.searchParams.set("product", String(productId));
    return url.href;
  }

  window.shareMenuProduct = function (productId, event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    var product = (window.products || []).find(function (item) {
      return String(item.id) === String(productId);
    });
    if (!product) return;
    var url = customerProductUrl(productId);
    var message = text("شاهد هذا المنتج من غصن الزيتون للتجارة: ", "See this product from Olive Branch Trading: ") + shown(product.name) + "\n" + url;
    if (navigator.share) {
      navigator.share({ title: shown(product.name), text: message, url: url }).catch(function (error) {
        if (error && error.name !== "AbortError") openDirectWhatsapp(message);
      });
    } else {
      openDirectWhatsapp(message);
    }
  };

  function openDirectWhatsapp(message) {
    var phone = digits(window.settings && window.settings.phone);
    var query = "phone=" + encodeURIComponent(phone) + "&text=" + encodeURIComponent(message);
    var userAgent = safe(navigator.userAgent);
    if (/Android/i.test(userAgent)) {
      location.assign("intent://send?" + query + "#Intent;scheme=whatsapp;package=com.whatsapp;end");
    } else if (/iPhone|iPad|iPod/i.test(userAgent)) {
      location.assign("whatsapp://send?" + query);
    } else {
      window.open("https://wa.me/" + phone + "?text=" + encodeURIComponent(message), "_blank");
    }
  }

  window.notifyProductAvailability = function (productId) {
    var product = (window.products || []).find(function (item) {
      return String(item.id) === String(productId);
    });
    if (!product) return;
    openDirectWhatsapp(text(
      "مرحبًا، أريد معرفة موعد توفر المنتج التالي:\n",
      "Hello, please tell me when this product is available:\n"
    ) + shown(product.name) + "\n" + customerProductUrl(productId));
  };

  function focusDeepLinkedProduct() {
    if (deepLinkHandled) return;
    var productId = new URLSearchParams(location.search).get("product");
    if (!productId) return;
    var card = document.querySelector('#grid .card[data-product-id="' + safe(productId).replace(/"/g, "") + '"]');
    if (!card) return;
    deepLinkHandled = true;
    card.classList.add("deepLinkFocus");
    window.setTimeout(function () {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 300);
  }

  function itemNoteFor(item, index) {
    var values = Object.values(window.cart || {});
    var exact = values.find(function (savedItem) {
      return String(savedItem.id) === String(item.id);
    });
    return safe((exact || values[index] || {}).note).trim();
  }

  function augmentCartItems() {
    var boxes = Array.prototype.slice.call(document.querySelectorAll("#cart .cartItem"));
    var values = Object.values(window.cart || {});
    boxes.forEach(function (box, index) {
      var item = values[index];
      if (!item || box.querySelector(".itemNote")) return;
      var note = document.createElement("textarea");
      note.className = "itemNote";
      note.placeholder = text("ملاحظة لهذا المنتج مثل: بدون حار", "Item note, e.g. no chili");
      note.value = safe(item.note);
      note.addEventListener("change", function () {
        if (window.cart[item.id]) {
          window.cart[item.id].note = note.value.trim();
          window.saveCart();
        }
      });
      box.appendChild(note);
    });
  }

  window.applyMenuCoupon = function () {
    var input = document.getElementById("couponCode");
    var state = document.getElementById("couponState");
    var code = safe(input && input.value).trim().toUpperCase();
    var coupon = validCoupon(code);
    if (!coupon) {
      appliedCouponCode = "";
      saveJson(APPLIED_COUPON_KEY, "");
      if (state) {
        state.className = "couponState bad";
        state.textContent = text("الكود غير صحيح أو انتهت صلاحيته.", "Invalid or expired coupon.");
      }
      window.renderCart();
      return;
    }
    appliedCouponCode = code;
    saveJson(APPLIED_COUPON_KEY, code);
    if (input) input.value = code;
    var subtotal = baseGetOrderTotals().subtotal;
    if (Number(subtotal || 0) < Number(coupon.minimum || 0)) {
      if (state) {
        state.className = "couponState bad";
        state.textContent = text("الكود صحيح، ويعمل عند وصول الطلب إلى ", "Valid code; it applies when the order reaches ") + moneyValue(coupon.minimum) + " " + text("درهم.", "AED.");
      }
      window.renderCart();
      return;
    }
    if (state) {
      state.className = "couponState ok";
      state.textContent = text("تم تطبيق خصم ", "Discount applied: ") + coupon.percent + "%";
    }
    window.renderCart();
  };

  function updateCheckoutExtras(totals) {
    updateAddressBookVisibility(totals);
    var scheduleFields = document.getElementById("deliveryScheduleFields");
    if (scheduleFields) scheduleFields.hidden = totals.deliveryType !== "delivery";
    var input = document.getElementById("couponCode");
    if (input && !input.value && appliedCouponCode) input.value = appliedCouponCode;
    var state = document.getElementById("couponState");
    var coupon = appliedCoupon(totals);
    if (state && coupon) {
      state.className = "couponState ok";
      state.textContent = text("خصم ", "Discount ") + coupon.percent + "% " + text("مطبق.", "applied.");
    }
    var summary = document.getElementById("summary");
    if (summary) {
      var old = summary.querySelector(".enhancementSummary");
      if (old) old.remove();
      var metadata = checkoutMetadata();
      var details = [];
      var zone = activeZone();
      var selectedAddress = selectedSavedAddress();
      if (totals.deliveryType === "delivery" && selectedAddress) {
        details.push(text("عنوان التوصيل: ", "Delivery address: ") + selectedAddress.label);
      }
      if (totals.deliveryType === "delivery" && zone) {
        details.push(text("منطقة التوصيل: ", "Delivery zone: ") + shown(zone.name));
        if (Number(zone.minimum || 0)) details.push(text("الحد الأدنى للمنطقة: ", "Zone minimum: ") + moneyValue(zone.minimum) + " " + text("درهم", "AED"));
      }
      if (metadata.deliveryDate) details.push(text("تاريخ التوصيل: ", "Delivery date: ") + metadata.deliveryDate);
      if (metadata.deliverySlot) details.push(text("الفترة: ", "Time: ") + shown(metadata.deliverySlot));
      if (metadata.couponCode) details.push(text("الكوبون: ", "Coupon: ") + metadata.couponCode + " (" + metadata.couponPercent + "%)");
      if (details.length) summary.insertAdjacentHTML("beforeend", '<div class="enhancementSummary">' + details.map(html).join("<br>") + '</div>');
      var discountRow = summary.querySelector(".discountRow span");
      if (discountRow && metadata.couponCode && coupon) {
        discountRow.textContent = text("كوبون ", "Coupon ") + metadata.couponCode + " (" + coupon.percent + "%)";
      }
    }
  }

  window.getOrderTotals = function () {
    var totals = baseGetOrderTotals();
    var zone = activeZone();
    if (totals.deliveryType === "delivery" && zone) {
      totals.delivery = Number(zone.fee || 0);
      totals.zoneMinimum = Number(zone.minimum || 0);
    } else {
      totals.zoneMinimum = 0;
    }
    var coupon = appliedCoupon(totals);
    if (coupon) {
      var couponDiscount = Number(totals.subtotal || 0) * Number(coupon.percent || 0) / 100;
      totals.discount = Math.max(Number(totals.discount || 0), couponDiscount);
      totals.couponCode = safe(coupon.code).toUpperCase();
      totals.couponPercent = Number(coupon.percent || 0);
    }
    totals.total = Math.max(0, Number(totals.subtotal || 0) + Number(totals.delivery || 0) - Number(totals.discount || 0));
    return totals;
  };

  window.render = function () {
    baseRender();
    augmentProductCards();
  };

  window.renderCart = function () {
    baseRenderCart();
    injectCustomerUi();
    renderDeliveryOptions();
    augmentCartItems();
    updateCheckoutExtras(window.getOrderTotals());
  };

  function refreshEnhancementUi() {
    injectCustomerUi();
    renderDeliveryOptions();
    renderOffers();
    updateFavoriteButton();
    translateEnhancementUi();
    if (document.getElementById("adminModal") && document.getElementById("adminModal").classList.contains("open")) {
      renderAdminConfig();
    }
  }

  window.loadCloudProducts = function () {
    var result = baseLoadCloudProducts.apply(this, arguments);
    if (!result || typeof result.then !== "function") {
      extractCloudMarkers();
      cacheCustomerProducts();
      refreshEnhancementUi();
      window.render();
      return result;
    }
    return result.then(function (value) {
      extractCloudMarkers();
      cacheCustomerProducts();
      applyTrackedStatusesToCurrentOrders();
      refreshEnhancementUi();
      window.render();
      window.renderCart();
      return value;
    });
  };

  window.openAdmin = function () {
    var result = baseOpenAdmin.apply(this, arguments);
    renderAdminConfig();
    return result;
  };

  window.gsPost = function (payload) {
    var updated = Object.assign({}, payload || {});
    if (updated.action === "createOrder") {
      var metadata = checkoutMetadata();
      var values = Object.values(window.cart || {});
      updated.notes = [safe(updated.notes), checkoutNotesText(metadata)].filter(Boolean).join(" | ");
      updated.items = (updated.items || []).map(function (item, index) {
        return Object.assign({}, item, { notes: itemNoteFor(values[index] || item, index) });
      });
    }
    return baseGsPost(updated);
  };

  window.sendWA = function () {
    var totals = window.getOrderTotals();
    if (totals.deliveryType === "delivery") {
      var deliveryArea = document.getElementById("area");
      var deliveryLocation = document.getElementById("location");
      if (!deliveryArea || !deliveryArea.value.trim()) {
        alert(text("اكتب وصف عنوان التوصيل.", "Enter the delivery address details."));
        if (deliveryArea) deliveryArea.focus();
        return;
      }
      if (!deliveryLocation || !deliveryLocation.value.trim()) {
        alert(text("حدد موقع التوصيل بالـ GPS أو اختره على الخريطة.", "Choose the delivery location using GPS or the map."));
        return;
      }
      if (Number(totals.zoneMinimum || 0) > 0 && Number(totals.subtotal || 0) < Number(totals.zoneMinimum)) {
        alert(text("الحد الأدنى للطلب في هذه المنطقة ", "Minimum order for this area is ") + moneyValue(totals.zoneMinimum) + " " + text("درهم", "AED"));
        return;
      }
      var schedule = selectedSchedule();
      if (!schedule.date || !schedule.slot) {
        alert(text("اختر تاريخ وفترة التوصيل.", "Choose a delivery date and time."));
        return;
      }
      if (schedule.date < minimumDeliveryDateValue()) {
        setMinimumDeliveryDate();
        alert(text("أقرب موعد توصيل متاح بعد 3 أيام من تاريخ الطلب.", "The earliest available delivery date is 3 days after ordering."));
        return;
      }
    }
    return baseSendWA.apply(this, arguments);
  };

  window.getGPS = function () {
    setSelectedAddressId("");
    renderSavedAddressOptions();
    return baseGetGPS.apply(this, arguments);
  };

  window.completeCustomerOrderReceiptFlow = function (order) {
    if (!order) return baseCompleteReceipt(order);
    var values = Object.values(window.cart || {});
    order.items = (order.items || []).map(function (item, index) {
      return Object.assign({}, item, { note: itemNoteFor(item, index) || safe(values[index] && values[index].note) });
    });
    order.enhancements = checkoutMetadata();
    order.whatsappUrl = appendWhatsappText(order.whatsappUrl, whatsappExtras(order));
    saveOrderHistory(JSON.parse(JSON.stringify(order)));
    return baseCompleteReceipt(order);
  };

  window.repeatLastOrder = function () {
    var history = orderHistory();
    if (!history.length) {
      alert(text("لا يوجد طلب سابق محفوظ على هذا الهاتف.", "No previous order is saved on this device."));
      return;
    }
    var previous = history[0];
    var added = 0;
    var skipped = 0;
    (previous.items || []).forEach(function (item) {
      var sourceId = item.productId || item.id;
      var fresh = (window.products || []).find(function (product) {
        return String(product.id) === String(sourceId);
      });
      if (!fresh || fresh.visible === false || fresh.available === false) {
        skipped += 1;
        return;
      }
      var key = item.id;
      window.cart[key] = Object.assign({}, fresh, item, {
        id: key,
        productId: sourceId,
        qty: Number(item.qty || 1)
      });
      added += 1;
    });
    if (!added) {
      alert(text("منتجات الطلب السابق غير متوفرة حاليًا.", "Items from the previous order are currently unavailable."));
      return;
    }
    window.saveCart();
    window.render();
    window.renderCart();
    window.openCart();
    if (skipped) {
      alert(text("تمت إعادة المنتجات المتوفرة فقط، وبعض المنتجات غير متاحة الآن.", "Available items were restored; some items are unavailable."));
    }
  };

  window.applySavedDeliveryAddress = function (addressId) {
    var previous = selectedSavedAddress();
    var areaInput = document.getElementById("area");
    var locationInput = document.getElementById("location");
    var address = savedAddresses().find(function (item) {
      return item.id === safe(addressId);
    });
    if (!address) {
      setSelectedAddressId("");
      if (previous) {
        if (areaInput && areaInput.value === previous.area) areaInput.value = "";
        if (locationInput && locationInput.value === previous.location) locationInput.value = "";
        clearLocationStatus();
      }
      renderSavedAddressOptions();
      window.renderCart();
      return;
    }
    applyingSavedAddress = true;
    setSelectedAddressId(address.id);
    if (areaInput) areaInput.value = address.area;
    if (locationInput) locationInput.value = address.location;
    applyingSavedAddress = false;
    renderSavedAddressOptions();
    showChosenLocation(address.location, text("تم اختيار عنوان «", "Selected “") + address.label + text("» للتوصيل", "” for delivery"));
    window.renderCart();
  };

  function openAddressEditor(address) {
    address = address || {};
    addressEditId = safe(address.id);
    var currentArea = safe(address.area || (document.getElementById("area") && document.getElementById("area").value)).trim();
    var currentLocation = safe(address.location || (document.getElementById("location") && document.getElementById("location").value)).trim();
    if (!currentArea || !currentLocation) {
      alert(text("اكتب وصف العنوان وحدد اللوكيشن أولًا، ثم اضغط حفظ العنوان.", "Enter the address and choose its map location first, then save it."));
      return;
    }
    openEnhancementHtml(
      '<h2>💾 ' + (addressEditId ? text("تعديل العنوان المحفوظ", "Edit saved address") : text("حفظ عنوان التوصيل", "Save delivery address")) + '</h2>' +
      '<div class="field"><label for="addressLabelInput">' + text("اسم العنوان", "Address name") + '</label>' +
        '<input id="addressLabelInput" maxlength="40" value="' + html(address.label || "") + '" placeholder="' + text("مثال: البيت أو المكتب", "Example: Home or Office") + '"></div>' +
      '<div class="field"><label for="savedAreaInput">' + text("وصف العنوان بالتفصيل", "Address details") + '</label>' +
        '<textarea id="savedAreaInput" maxlength="240" placeholder="' + text("المنطقة، الشارع، المبنى، الطابق", "Area, street, building, floor") + '">' + html(currentArea) + '</textarea></div>' +
      '<div class="field"><label for="addressLocationValue">' + text("رابط الموقع", "Map location") + '</label>' +
        '<input id="addressLocationValue" dir="ltr" readonly value="' + html(currentLocation) + '"></div>' +
      '<button class="primary addressModalAction" type="button" onclick="confirmSaveDeliveryAddress()">' + text("حفظ واستخدام هذا العنوان", "Save and use this address") + '</button>');
    window.setTimeout(function () {
      var labelInput = document.getElementById("addressLabelInput");
      if (labelInput) labelInput.focus();
    }, 80);
  }

  window.saveCurrentDeliveryAddress = function () {
    openAddressEditor(null);
  };

  window.editSavedDeliveryAddress = function (addressId) {
    var address = savedAddresses().find(function (item) { return item.id === safe(addressId); });
    if (address) openAddressEditor(address);
  };

  window.confirmSaveDeliveryAddress = function () {
    var labelInput = document.getElementById("addressLabelInput");
    var areaInput = document.getElementById("savedAreaInput");
    var locationInput = document.getElementById("addressLocationValue");
    var label = safe(labelInput && labelInput.value).trim();
    var addressArea = safe(areaInput && areaInput.value).trim();
    var addressLocation = safe(locationInput && locationInput.value).trim();
    if (!label) {
      alert(text("اكتب اسمًا للعنوان مثل البيت أو المكتب.", "Name the address, for example Home or Office."));
      if (labelInput) labelInput.focus();
      return;
    }
    if (!addressArea || !addressLocation) {
      alert(text("وصف العنوان واللوكيشن مطلوبان.", "Address details and map location are required."));
      return;
    }
    var addresses = savedAddresses();
    var editIndex = addresses.findIndex(function (item) { return item.id === addressEditId; });
    if (editIndex < 0) {
      editIndex = addresses.findIndex(function (item) {
        return normalize(item.label) === normalize(label);
      });
    }
    var savedAddress = {
      id: editIndex >= 0 ? addresses[editIndex].id : "address-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7),
      label: label,
      area: addressArea,
      location: addressLocation,
      updatedAt: Date.now()
    };
    if (editIndex >= 0) addresses.splice(editIndex, 1);
    addresses.unshift(savedAddress);
    saveAddresses(addresses);
    setSelectedAddressId(savedAddress.id);
    var checkoutArea = document.getElementById("area");
    var checkoutLocation = document.getElementById("location");
    applyingSavedAddress = true;
    if (checkoutArea) checkoutArea.value = savedAddress.area;
    if (checkoutLocation) checkoutLocation.value = savedAddress.location;
    applyingSavedAddress = false;
    window.closeEnhancementModal();
    renderSavedAddressOptions();
    showChosenLocation(savedAddress.location, text("تم حفظ واختيار عنوان «", "Saved and selected “") + savedAddress.label + "»");
    window.renderCart();
  };

  function savedAddressCards() {
    var addresses = savedAddresses();
    if (!addresses.length) {
      return '<div class="installHint">' + text("لا توجد عناوين محفوظة بعد.", "No addresses are saved yet.") + '</div>';
    }
    return '<div class="savedAddressList">' + addresses.map(function (address) {
      return '<article class="savedAddressCard' + (address.id === selectedAddressId ? " active" : "") + '">' +
        '<div><b>' + addressTypeIcon(address.label) + ' ' + html(address.label) + '</b><p>' + html(address.area) + '</p>' +
          '<a href="' + html(address.location) + '" target="_blank" rel="noopener">' + text("فتح على الخريطة", "Open in Maps") + '</a></div>' +
        '<div class="savedAddressActions">' +
          '<button class="primary" type="button" onclick="useManagedDeliveryAddress(\'' + html(address.id) + '\')">' + text("استخدام", "Use") + '</button>' +
          '<button class="secondary" type="button" onclick="editSavedDeliveryAddress(\'' + html(address.id) + '\')">' + text("تعديل", "Edit") + '</button>' +
          '<button class="danger" type="button" onclick="deleteSavedDeliveryAddress(\'' + html(address.id) + '\')">' + text("حذف", "Delete") + '</button>' +
        '</div></article>';
    }).join("") + "</div>";
  }

  window.openSavedAddressManager = function () {
    openEnhancementHtml('<h2>⚙️ ' + text("عناويني المحفوظة", "My saved addresses") + '</h2>' + savedAddressCards());
  };

  window.useManagedDeliveryAddress = function (addressId) {
    window.applySavedDeliveryAddress(addressId);
    window.closeEnhancementModal();
  };

  window.deleteSavedDeliveryAddress = function (addressId) {
    var address = savedAddresses().find(function (item) { return item.id === safe(addressId); });
    if (!address) return;
    if (!window.confirm(text("حذف عنوان «", "Delete “") + address.label + text("»؟", "”?"))) return;
    var wasSelected = address.id === selectedAddressId;
    saveAddresses(savedAddresses().filter(function (item) { return item.id !== address.id; }));
    if (wasSelected) {
      setSelectedAddressId("");
      var checkoutArea = document.getElementById("area");
      var checkoutLocation = document.getElementById("location");
      if (checkoutArea && checkoutArea.value === address.area) checkoutArea.value = "";
      if (checkoutLocation && checkoutLocation.value === address.location) checkoutLocation.value = "";
      clearLocationStatus();
    }
    renderSavedAddressOptions();
    window.openSavedAddressManager();
  };

  function destroyDeliveryMap() {
    if (deliveryMapInstance) {
      try { deliveryMapInstance.remove(); } catch (error) {}
    }
    deliveryMapInstance = null;
    deliveryMapMarker = null;
    deliveryMapSelection = null;
  }

  function setDeliveryMapPoint(latitude, longitude, centerMap) {
    if (!deliveryMapInstance || !window.L) return;
    var point = [Number(latitude), Number(longitude)];
    deliveryMapSelection = { lat: point[0], lng: point[1] };
    if (!deliveryMapMarker) {
      var icon = window.L.divIcon({
        className: "deliveryMapPinIcon",
        html: '<span aria-hidden="true">📍</span>',
        iconSize: [42, 48],
        iconAnchor: [21, 44]
      });
      deliveryMapMarker = window.L.marker(point, { icon: icon, draggable: true }).addTo(deliveryMapInstance);
      deliveryMapMarker.on("dragend", function () {
        var position = deliveryMapMarker.getLatLng();
        deliveryMapSelection = { lat: position.lat, lng: position.lng };
      });
    } else {
      deliveryMapMarker.setLatLng(point);
    }
    if (centerMap) deliveryMapInstance.setView(point, Math.max(deliveryMapInstance.getZoom(), 16));
    var button = document.getElementById("confirmMapAddressButton");
    if (button) button.disabled = false;
    var state = document.getElementById("deliveryMapState");
    if (state) state.textContent = text("✓ تم وضع العلامة. يمكنك سحبها لضبط المكان.", "✓ Pin placed. Drag it to fine-tune the location.");
  }

  function initializeDeliveryMapPicker() {
    var mapElement = document.getElementById("deliveryMapPicker");
    if (!mapElement) return;
    if (!window.L) {
      mapElement.innerHTML = '<div class="mapUnavailable">' + text("تعذر تحميل الخريطة. أغلق النافذة واستخدم زر GPS.", "The map could not load. Close this window and use GPS.") + '</div>';
      return;
    }
    var currentLocation = document.getElementById("location");
    var existing = parseCoordinates(currentLocation && currentLocation.value);
    var initial = existing || { lat: 24.4539, lng: 54.3773 };
    destroyDeliveryMap();
    deliveryMapInstance = window.L.map(mapElement, { zoomControl: true }).setView([initial.lat, initial.lng], existing ? 16 : 8);
    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>'
    }).addTo(deliveryMapInstance);
    deliveryMapInstance.on("click", function (event) {
      setDeliveryMapPoint(event.latlng.lat, event.latlng.lng, false);
    });
    if (existing) setDeliveryMapPoint(existing.lat, existing.lng, false);
    window.setTimeout(function () {
      if (deliveryMapInstance) deliveryMapInstance.invalidateSize();
    }, 180);
  }

  function deliveryAddressSearchQuery(value) {
    var normalizedValue = normalize(value);
    if (normalizedValue.indexOf("بين الجسرين") !== -1 || normalizedValue.indexOf("بين الجسران") !== -1) {
      return "Bain al Jisrain Between the Bridges Abu Dhabi United Arab Emirates";
    }
    return value;
  }

  function photonAddressText(properties) {
    properties = properties || {};
    var parts = [
      properties.name,
      properties.housenumber && properties.street ? properties.housenumber + " " + properties.street : properties.street,
      properties.district,
      properties.city,
      properties.county,
      properties.state,
      properties.postcode,
      properties.country
    ];
    var used = {};
    return parts.filter(function (part) {
      var value = safe(part).trim();
      var key = normalize(value);
      if (!value || used[key]) return false;
      used[key] = true;
      return true;
    }).join(text("، ", ", "));
  }

  function showDeliveryAddressSearchResults(results) {
    deliveryAddressSearchResults = results;
    var container = document.getElementById("mapSearchResults");
    if (!container) return;
    if (!results.length) {
      container.innerHTML = '<div class="mapSearchMessage">' + text("لم نجد عنوانًا داخل الإمارات. جرّب اسم المنطقة والمدينة، أو اختر المكان يدويًا على الخريطة.", "No address was found in the UAE. Try the area and city, or choose the point manually on the map.") + '</div>';
      return;
    }
    container.innerHTML = results.map(function (result, index) {
      return '<button class="mapSearchResult" type="button" onclick="chooseDeliveryAddressSearchResult(' + index + ')">' +
        '<span aria-hidden="true">📍</span><span><b>' + html(result.title) + '</b><small>' + html(result.address) + '</small></span>' +
      '</button>';
    }).join("");
  }

  window.searchDeliveryAddress = function () {
    var input = document.getElementById("mapAddressSearchInput");
    var button = document.getElementById("mapAddressSearchButton");
    var container = document.getElementById("mapSearchResults");
    var rawQuery = safe(input && input.value).trim();
    if (rawQuery.length < 2) {
      if (container) container.innerHTML = '<div class="mapSearchMessage">' + text("اكتب اسم المنطقة أو الشارع أولًا.", "Enter an area or street first.") + '</div>';
      if (input) input.focus();
      return Promise.resolve([]);
    }
    var query = deliveryAddressSearchQuery(rawQuery);
    var normalizedRawQuery = normalize(rawQuery);
    var aliasTitle = normalizedRawQuery.indexOf("بين الجسرين") !== -1 || normalizedRawQuery.indexOf("بين الجسران") !== -1
      ? text("بين الجسرين", "Between Two Bridges")
      : "";
    var cacheKey = normalize(query);
    if (deliveryAddressSearchCache[cacheKey]) {
      showDeliveryAddressSearchResults(deliveryAddressSearchCache[cacheKey]);
      return Promise.resolve(deliveryAddressSearchCache[cacheKey]);
    }
    if (button) button.disabled = true;
    if (container) container.innerHTML = '<div class="mapSearchMessage loading">' + text("جارٍ البحث عن العنوان...", "Searching for the address...") + '</div>';
    var endpoint = "https://photon.komoot.io/api/?limit=6&lat=24.4539&lon=54.3773&q=" + encodeURIComponent(query);
    return fetch(endpoint, { headers: { Accept: "application/json" } }).then(function (response) {
      if (!response || !response.ok) throw new Error("ADDRESS_SEARCH_FAILED");
      return response.json();
    }).then(function (payload) {
      var results = (payload && payload.features || []).filter(function (feature) {
        return feature && feature.geometry && Array.isArray(feature.geometry.coordinates) &&
          safe(feature.properties && feature.properties.countrycode).toUpperCase() === "AE";
      }).slice(0, 5).map(function (feature, index) {
        var properties = feature.properties || {};
        var coordinates = feature.geometry.coordinates;
        var address = photonAddressText(properties);
        var originalTitle = safe(properties.name || properties.street || properties.city || address).trim();
        var title = aliasTitle && index === 0 ? aliasTitle : originalTitle;
        if (aliasTitle && index === 0 && safe(properties.name)) {
          address = address.replace(safe(properties.name).trim(), aliasTitle);
        }
        return {
          lat: Number(coordinates[1]),
          lng: Number(coordinates[0]),
          title: title,
          address: address
        };
      }).filter(function (result) {
        return Number.isFinite(result.lat) && Number.isFinite(result.lng) && result.address;
      });
      deliveryAddressSearchCache[cacheKey] = results;
      showDeliveryAddressSearchResults(results);
      return results;
    }).catch(function () {
      if (container) container.innerHTML = '<div class="mapSearchMessage error">' + text("تعذر البحث الآن. يمكنك المحاولة مرة أخرى أو اختيار المكان يدويًا على الخريطة.", "Search is unavailable right now. Try again or choose the point manually on the map.") + '</div>';
      return [];
    }).then(function (results) {
      if (button) button.disabled = false;
      return results;
    });
  };

  window.chooseDeliveryAddressSearchResult = function (index) {
    var result = deliveryAddressSearchResults[Number(index)];
    if (!result) return;
    setDeliveryMapPoint(result.lat, result.lng, true);
    var addressField = document.getElementById("mapAddressText");
    if (addressField) addressField.value = result.address;
    var container = document.getElementById("mapSearchResults");
    if (container) container.innerHTML = '<div class="mapSearchMessage selected">✓ ' + text("تم اختيار ", "Selected ") + html(result.title) + '</div>';
    var state = document.getElementById("deliveryMapState");
    if (state) state.textContent = text("✓ تم تحديد العنوان على الخريطة. أضف رقم المبنى أو الفيلا إن وجد.", "✓ Address located on the map. Add the building or villa number if needed.");
  };

  window.openDeliveryMapPicker = function () {
    addressEditId = "";
    pendingAddressType = "home";
    deliveryAddressSearchResults = [];
    var areaInput = document.getElementById("area");
    openEnhancementHtml(
      '<h2>📍 ' + text("إضافة عنوان توصيل", "Add delivery address") + '</h2>' +
      '<div class="addressTypeTitle">' + text("سمِّ هذا العنوان", "Name this address") + '</div>' +
      '<div class="addressTypeOptions" role="group" aria-label="' + text("نوع العنوان", "Address type") + '">' +
        '<button class="addressTypeButton active" type="button" aria-pressed="true" onclick="selectDeliveryAddressType(\'home\',this)">🏠 ' + text("البيت", "Home") + '</button>' +
        '<button class="addressTypeButton" type="button" aria-pressed="false" onclick="selectDeliveryAddressType(\'office\',this)">🏢 ' + text("المكتب", "Office") + '</button>' +
        '<button class="addressTypeButton" type="button" aria-pressed="false" onclick="selectDeliveryAddressType(\'other\',this)">📍 ' + text("عنوان آخر", "Other") + '</button>' +
      '</div>' +
      '<input id="customAddressLabel" class="customAddressLabel" maxlength="40" placeholder="' + text("مثال: بيت الوالد", "Example: Parents' home") + '" hidden>' +
      '<div class="mapAddressSearch">' +
        '<label for="mapAddressSearchInput">🔎 ' + text("ابحث عن المنطقة أو الشارع", "Search for an area or street") + '</label>' +
        '<div class="mapAddressSearchLine"><input id="mapAddressSearchInput" type="search" autocomplete="off" placeholder="' + text("مثال: بين الجسرين أبوظبي", "Example: Between Two Bridges Abu Dhabi") + '" onkeydown="if(event.key===\'Enter\'){event.preventDefault();searchDeliveryAddress()}">' +
          '<button id="mapAddressSearchButton" class="primary" type="button" onclick="searchDeliveryAddress()">' + text("بحث", "Search") + '</button></div>' +
        '<div id="mapSearchResults" class="mapSearchResults" aria-live="polite"></div>' +
        '<div class="mapSearchCredit">' + text("نتائج البحث من ", "Search results by ") + '<a href="https://photon.komoot.io" target="_blank" rel="noopener">Photon</a> / <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a></div>' +
      '</div>' +
      '<div class="mapPickerHint">' + text("اختر نتيجة البحث، أو اضغط مكان التوصيل على الخريطة يدويًا.", "Choose a search result, or tap the delivery point on the map manually.") + '</div>' +
      '<button id="mapCurrentLocationButton" class="secondary mapCurrentLocation" type="button" onclick="centerDeliveryMapOnCurrentLocation()">🎯 ' + text("استخدم موقعي الحالي كبداية", "Use my current location as a starting point") + '</button>' +
      '<div id="deliveryMapPicker" class="deliveryMapPicker" role="application" aria-label="' + text("خريطة اختيار موقع التوصيل", "Delivery location map") + '"></div>' +
      '<div id="deliveryMapState" class="deliveryMapState">' + text("اضغط على الخريطة لوضع علامة التوصيل.", "Tap the map to place the delivery pin.") + '</div>' +
      '<div class="field mapAddressField"><label for="mapAddressText">' + text("وصف العنوان بالتفصيل", "Address details") + '</label>' +
        '<textarea id="mapAddressText" maxlength="240" placeholder="' + text("المنطقة، الشارع، المبنى، الطابق", "Area, street, building, floor") + '">' + html(areaInput && areaInput.value || "") + '</textarea></div>' +
      '<button id="confirmMapAddressButton" class="primary addressModalAction" type="button" onclick="confirmDeliveryMapLocation()" disabled>' + text("حفظ واستخدام العنوان", "Save and use address") + '</button>');
    window.setTimeout(initializeDeliveryMapPicker, 80);
  };

  window.selectDeliveryAddressType = function (type, button) {
    pendingAddressType = type === "office" || type === "other" ? type : "home";
    document.querySelectorAll(".addressTypeButton").forEach(function (item) {
      var selected = item === button;
      item.classList.toggle("active", selected);
      item.setAttribute("aria-pressed", selected ? "true" : "false");
    });
    var customLabel = document.getElementById("customAddressLabel");
    if (customLabel) {
      customLabel.hidden = pendingAddressType !== "other";
      if (!customLabel.hidden) customLabel.focus();
    }
  };

  window.centerDeliveryMapOnCurrentLocation = function () {
    var button = document.getElementById("mapCurrentLocationButton");
    var state = document.getElementById("deliveryMapState");
    if (!navigator.geolocation) {
      if (state) state.textContent = text("تحديد الموقع غير مدعوم على هذا الجهاز.", "Location is not supported on this device.");
      return;
    }
    if (button) button.disabled = true;
    if (state) state.textContent = text("جارٍ تحديد موقعك...", "Getting your location...");
    navigator.geolocation.getCurrentPosition(function (position) {
      if (button) button.disabled = false;
      setDeliveryMapPoint(position.coords.latitude, position.coords.longitude, true);
    }, function () {
      if (button) button.disabled = false;
      if (state) state.textContent = text("تعذر تحديد موقعك. يمكنك اختيار المكان يدويًا على الخريطة.", "Could not get your location. You can still choose a point manually.");
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  };

  window.confirmDeliveryMapLocation = function () {
    var addressText = safe(document.getElementById("mapAddressText") && document.getElementById("mapAddressText").value).trim();
    var customLabel = document.getElementById("customAddressLabel");
    var label = pendingAddressType === "other"
      ? safe(customLabel && customLabel.value).trim()
      : addressTypeLabel(pendingAddressType);
    if (!deliveryMapSelection) {
      alert(text("اضغط على مكان التوصيل في الخريطة أولًا.", "Tap the delivery point on the map first."));
      return;
    }
    if (!label) {
      alert(text("اكتب اسمًا للعنوان.", "Enter a name for this address."));
      if (customLabel) customLabel.focus();
      return;
    }
    if (!addressText) {
      alert(text("اكتب وصف العنوان بالتفصيل.", "Enter the address details."));
      var field = document.getElementById("mapAddressText");
      if (field) field.focus();
      return;
    }
    var latitude = Number(deliveryMapSelection.lat).toFixed(6);
    var longitude = Number(deliveryMapSelection.lng).toFixed(6);
    var url = "https://maps.google.com/?q=" + latitude + "," + longitude;
    var addresses = savedAddresses();
    var savedAddress = {
      id: "address-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7),
      label: label,
      area: addressText,
      location: url,
      updatedAt: Date.now()
    };
    addresses.unshift(savedAddress);
    saveAddresses(addresses);
    setSelectedAddressId(savedAddress.id);
    var areaInput = document.getElementById("area");
    var locationInput = document.getElementById("location");
    applyingSavedAddress = true;
    if (areaInput) areaInput.value = addressText;
    if (locationInput) locationInput.value = url;
    applyingSavedAddress = false;
    window.closeEnhancementModal();
    renderSavedAddressOptions();
    showChosenLocation(url, text("تم حفظ واختيار عنوان «", "Saved and selected “") + savedAddress.label + "»");
    window.renderCart();
  };

  window.closeEnhancementModal = function () {
    stopLiveTracking();
    destroyDeliveryMap();
    var modal = document.getElementById("enhancementModal");
    if (modal) modal.classList.remove("open");
  };

  function openEnhancementHtml(content) {
    var body = document.getElementById("enhancementModalBody");
    var modal = document.getElementById("enhancementModal");
    if (body) body.innerHTML = content;
    if (modal) modal.classList.add("open");
  }

  function normalizedPhoneDigits(phone) {
    var value = digits(phone);
    if (value.indexOf("00971") === 0) value = value.slice(5);
    else if (value.indexOf("971") === 0) value = value.slice(3);
    if (value.length === 10 && value.charAt(0) === "0") value = value.slice(1);
    return value;
  }

  function hashPhoneDigits(value) {
    var hashValue = "olive-branch-status-v1|" + safe(value);
    if (window.crypto && window.crypto.subtle && window.TextEncoder) {
      return window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(hashValue)).then(function (buffer) {
        return Array.prototype.map.call(new Uint8Array(buffer), function (byte) {
          return byte.toString(16).padStart(2, "0");
        }).join("");
      });
    }
    var hash = 2166136261;
    for (var index = 0; index < hashValue.length; index += 1) {
      hash ^= hashValue.charCodeAt(index);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return Promise.resolve("fallback-" + (hash >>> 0).toString(16));
  }

  function phoneHash(phone) {
    return hashPhoneDigits(normalizedPhoneDigits(phone));
  }

  function phoneHashCandidates(phone) {
    var raw = digits(phone);
    var normalized = normalizedPhoneDigits(phone);
    var values = [normalized, raw];
    if (normalized.length === 9) {
      values.push("0" + normalized, "971" + normalized, "00971" + normalized);
    }
    values = values.filter(function (value, index, all) {
      return value && all.indexOf(value) === index;
    });
    return Promise.all(values.map(hashPhoneDigits));
  }

  window.openTrackingModal = function () {
    stopLiveTracking();
    var latest = orderHistory()[0] || {};
    var latestPhone = latest.record && latest.record.phone || "";
    openEnhancementHtml(
      '<h2>🚚 ' + text("تتبّع الطلب", "Track order") + '</h2>' +
      '<div class="field"><label for="trackingPhone">' + text("رقم الهاتف المستخدم في الطلب", "Phone number used for the order") + '</label><input id="trackingPhone" inputmode="tel" value="' + html(latestPhone) + '"></div>' +
      '<button class="primary" style="width:100%" type="button" onclick="checkOrderTracking()">' + text("تحديث وعرض كل طلباتي", "Refresh and show all my orders") + '</button>' +
      '<div id="trackingLiveState" class="trackingLiveState" aria-live="polite">' + text("يتم تحديث الحالة تلقائيًا كل 5 ثوانٍ.", "Status refreshes automatically every 5 seconds.") + '</div>' +
      '<div id="trackingResult" class="trackingResult" hidden></div>');
  };

  function statusIndex(status) {
    var value = safe(status);
    if (value === "تم التسليم") return 4;
    if (value === "خرج للتوصيل" || value === "جاهز" || value === "جاهز للاستلام") return 3;
    if (value === "قيد التجهيز" || value === "جاري التجهيز") return 2;
    if (value === "تم التأكيد") return 1;
    return 0;
  }

  function trackingMarkup(order) {
    var orderNo = order.orderNo;
    var status = order.status;
    var details = [];
    if (order.dateText) details.push(html(order.dateText));
    if (order.total != null && order.total !== "") details.push(html(moneyValue(order.total)) + " " + text("درهم", "AED"));
    if (order.deliveryType) {
      details.push(order.deliveryType === "delivery" ? text("توصيل", "Delivery") : text("استلام", "Pickup"));
    }
    if (status === "ملغي") {
      return '<article class="trackingOrderCard"><div class="trackingHeadline">' + text("الطلب رقم #", "Order #") + html(orderNo) + '</div>' +
        (details.length ? '<div class="trackingMeta">' + details.join(" • ") + '</div>' : '') +
        '<div class="trackingHeadline" style="color:#9b1c15">' + text("تم إلغاء الطلب", "Order cancelled") + '</div></article>';
    }
    var isPickupOrder = /pickup|استلام/i.test(safe(order.deliveryType)) || status === "جاهز للاستلام";
    var labels = isEnglish()
      ? ["New", "Confirmed", "Preparing", isPickupOrder ? "Ready for pickup" : "Out for delivery", "Completed"]
      : ["جديد", "تم التأكيد", "جاري التجهيز", isPickupOrder ? "جاهز للاستلام" : "خرج للتوصيل", "مكتمل"];
    var currentIndex = statusIndex(status);
    return '<article class="trackingOrderCard"><div class="trackingHeadline">' + text("الطلب رقم #", "Order #") + html(orderNo) + '</div>' +
      (details.length ? '<div class="trackingMeta">' + details.join(" • ") + '</div>' : '') +
      '<p>' + text("الحالة الحالية: ", "Current status: ") + '<b>' + html(status || text("جديد", "New")) + '</b></p>' +
      '<div class="statusSteps">' + labels.map(function (label, index) {
        return '<div class="statusStep ' + (index < currentIndex ? "done" : index === currentIndex ? "current" : "") + '">' + html(label) + '</div>';
      }).join("") + '</div></article>';
  }

  function setTrackingLiveState(message, failed) {
    var state = document.getElementById("trackingLiveState");
    if (!state) return;
    state.textContent = message || "";
    state.classList.toggle("failed", !!failed);
  }

  function trackingModalIsOpen() {
    var modal = document.getElementById("enhancementModal");
    return !!(modal && modal.classList.contains("open") && document.getElementById("trackingPhone"));
  }

  function stopLiveTracking() {
    trackingRefreshGeneration += 1;
    if (trackingRefreshTimer) window.clearTimeout(trackingRefreshTimer);
    trackingRefreshTimer = 0;
  }

  function applyRemoteStatusCollection(remote) {
    if (!remote || !remote.collection || !remote.collection.orders) return false;
    statusCollectionMarkerId = Number(remote.id || statusCollectionMarkerId || 0);
    statusCollection = remote.collection;
    Object.keys(statusCollection.orders).forEach(function (number) {
      statusMarkers[String(number)] = {
        id: statusCollectionMarkerId,
        data: statusCollection.orders[number]
      };
    });
    statusMarkersLoaded = true;
    return true;
  }

  function refreshTrackingStatusesFromCloud() {
    if (trackingRefreshPromise) return trackingRefreshPromise;
    trackingRefreshPromise = readRemoteStatusCollection().then(function (remote) {
      applyRemoteStatusCollection(remote);
      trackingRefreshPromise = null;
      return remote;
    }, function (error) {
      trackingRefreshPromise = null;
      throw error;
    });
    return trackingRefreshPromise;
  }

  function renderTrackingResults(phone) {
    var result = document.getElementById("trackingResult");
    if (!result) return Promise.resolve(false);
    return phoneHashCandidates(phone).then(function (hashes) {
      var matches = {};
      Object.keys(statusMarkers).forEach(function (number) {
        var marker = statusMarkers[number];
        if (marker && marker.data && hashes.indexOf(marker.data.phoneHash) !== -1) {
          matches[String(number)] = {
            orderNo: String(number),
            status: marker.data.status || text("جديد", "New"),
            updatedAt: marker.data.updatedAt || "",
            deliveryType: marker.data.deliveryType || ""
          };
        }
      });
      orderHistory().forEach(function (order) {
        if (normalizedPhoneDigits(order.record && order.record.phone) !== normalizedPhoneDigits(phone)) return;
        var number = String(order.orderNo);
        var current = matches[number] || {};
        matches[number] = {
          orderNo: number,
          status: current.status || text("جديد", "New"),
          updatedAt: current.updatedAt || order.savedAt || "",
          dateText: order.record && order.record.dateText || "",
          total: order.totals && order.totals.total,
          deliveryType: order.totals && order.totals.deliveryType || current.deliveryType || ""
        };
      });
      var ordersForPhone = Object.keys(matches).map(function (number) {
        return matches[number];
      }).sort(function (first, second) {
        var firstTime = Date.parse(first.updatedAt) || Number(first.updatedAt) || Number(first.orderNo) || 0;
        var secondTime = Date.parse(second.updatedAt) || Number(second.updatedAt) || Number(second.orderNo) || 0;
        return secondTime - firstTime;
      });
      if (ordersForPhone.length) {
        result.innerHTML = '<div class="trackingCount">' +
          text("عدد الطلبات: ", "Orders found: ") + '<b>' + ordersForPhone.length + '</b></div>' +
          ordersForPhone.map(trackingMarkup).join("");
      } else {
        result.innerHTML = '<div class="trackingHeadline" style="color:#9b1c15">' + text("لم نجد طلبًا مطابقًا لهذه البيانات.", "No matching order was found.") + '</div>';
      }
      result.hidden = false;
      return ordersForPhone.length > 0;
    });
  }

  function scheduleLiveTracking(phone, generation) {
    if (generation !== trackingRefreshGeneration || !trackingModalIsOpen()) return;
    if (trackingRefreshTimer) window.clearTimeout(trackingRefreshTimer);
    trackingRefreshTimer = window.setTimeout(function () {
      runLiveTrackingRefresh(phone, generation);
    }, TRACKING_REFRESH_MS);
  }

  function runLiveTrackingRefresh(phone, generation) {
    if (generation !== trackingRefreshGeneration || !trackingModalIsOpen()) return Promise.resolve(false);
    var input = document.getElementById("trackingPhone");
    if (!input || digits(input.value) !== digits(phone)) return Promise.resolve(false);
    setTrackingLiveState(text("جارٍ جلب أحدث حالة...", "Loading latest status..."), false);
    return refreshTrackingStatusesFromCloud().then(function () {
      if (generation !== trackingRefreshGeneration || !trackingModalIsOpen()) return false;
      return renderTrackingResults(phone).then(function () {
        setTrackingLiveState(text("✓ الحالة محدثة الآن — تحديث تلقائي كل 5 ثوانٍ", "✓ Status is live — refreshing every 5 seconds"), false);
        return true;
      });
    }).catch(function () {
      if (generation === trackingRefreshGeneration && trackingModalIsOpen()) {
        setTrackingLiveState(text("تعذر الاتصال مؤقتًا — ستتم المحاولة تلقائيًا", "Temporarily offline — retrying automatically"), true);
      }
      return false;
    }).then(function (updated) {
      scheduleLiveTracking(phone, generation);
      return updated;
    });
  }

  window.checkOrderTracking = function () {
    var phone = safe(document.getElementById("trackingPhone") && document.getElementById("trackingPhone").value).trim();
    if (digits(phone).length < 8) {
      alert(text("اكتب رقم الهاتف الصحيح.", "Enter a valid phone number."));
      return Promise.resolve(false);
    }
    stopLiveTracking();
    var generation = trackingRefreshGeneration;
    setTrackingLiveState(text("جارٍ عرض الطلبات وجلب أحدث حالة...", "Showing orders and loading latest status..."), false);
    return renderTrackingResults(phone).then(function () {
      return runLiveTrackingRefresh(phone, generation);
    });
  };

  function trimStatusCollection() {
    var entries = Object.keys(statusCollection.orders || {}).map(function (number) {
      return { number: number, data: statusCollection.orders[number] };
    }).sort(function (first, second) {
      return (Date.parse(second.data.updatedAt) || 0) - (Date.parse(first.data.updatedAt) || 0);
    }).slice(0, 100);
    var trimmed = {};
    entries.forEach(function (entry) {
      trimmed[entry.number] = entry.data;
    });
    statusCollection = { version: 2, orders: trimmed };
  }

  function wait(milliseconds) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, milliseconds);
    });
  }

  function adminSession() {
    try {
      return sessionStorage.getItem(ADMIN_SESSION_KEY) || "";
    } catch (error) {
      return "";
    }
  }

  function directJsonp(action, params) {
    return new Promise(function (resolve, reject) {
      if (!window.gsUrl || !window.gsUrl()) {
        reject(new Error("NO_URL"));
        return;
      }
      var callback = "__olive_sync_" + Date.now() + "_" + Math.random().toString(36).slice(2);
      var script = document.createElement("script");
      var timer = window.setTimeout(function () {
        cleanup();
        reject(new Error("TIMEOUT"));
      }, 15000);
      function cleanup() {
        window.clearTimeout(timer);
        try { delete window[callback]; } catch (error) { window[callback] = undefined; }
        script.remove();
      }
      window[callback] = function (result) {
        cleanup();
        if (!result || result.ok === false) {
          reject(new Error(result && result.error || "FAILED"));
          return;
        }
        resolve(result);
      };
      var query = new URLSearchParams(Object.assign({
        action: action,
        callback: callback,
        _t: Date.now()
      }, params || {}));
      script.src = window.gsUrl() + (window.gsUrl().indexOf("?") === -1 ? "?" : "&") + query.toString();
      script.onerror = function () {
        cleanup();
        reject(new Error("NETWORK"));
      };
      document.head.appendChild(script);
    });
  }

  function directFetch(action, params) {
    return new Promise(function (resolve, reject) {
      if (!window.gsUrl || !window.gsUrl()) {
        reject(new Error("NO_URL"));
        return;
      }
      if (typeof window.fetch !== "function") {
        reject(new Error("FETCH_UNAVAILABLE"));
        return;
      }
      var finished = false;
      var timer = window.setTimeout(function () {
        if (finished) return;
        finished = true;
        reject(new Error("FETCH_TIMEOUT"));
      }, 15000);
      var query = new URLSearchParams(Object.assign({
        action: action,
        _t: Date.now()
      }, params || {}));
      window.fetch(window.gsUrl() + (window.gsUrl().indexOf("?") === -1 ? "?" : "&") + query.toString(), {
        method: "GET",
        cache: "no-store",
        redirect: "follow"
      }).then(function (response) {
        if (!response.ok) throw new Error("HTTP_" + response.status);
        return response.json();
      }).then(function (result) {
        if (finished) return;
        finished = true;
        window.clearTimeout(timer);
        if (!result || result.ok === false) {
          reject(new Error(result && result.error || "FAILED"));
          return;
        }
        resolve(result);
      }).catch(function (error) {
        if (finished) return;
        finished = true;
        window.clearTimeout(timer);
        reject(error);
      });
    });
  }

  function directPublicRequest(action, params) {
    return new Promise(function (resolve, reject) {
      var failures = [];
      [directFetch(action, params), directJsonp(action, params)].forEach(function (request) {
        request.then(resolve).catch(function (error) {
          failures.push(error);
          if (failures.length === 2) reject(failures[0]);
        });
      });
    });
  }

  function fallbackPayload(payload) {
    var updated = Object.assign({}, payload || {});
    delete updated.pin;
    if (["orders", "updateStatus", "saveProduct"].indexOf(safe(updated.action)) !== -1) {
      updated.session = adminSession();
    }
    return updated;
  }

  function postWithoutCors(payload) {
    return window.fetch(window.gsUrl(), {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(fallbackPayload(payload)),
      redirect: "follow"
    });
  }

  function applyTrackedStatusesToCurrentOrders() {
    (window.orders || []).forEach(function (order) {
      var marker = statusMarkers[String(order.orderNo)];
      if (marker && marker.data && marker.data.status) {
        order.status = marker.data.status;
      }
    });
  }

  function loadOrdersDirectly(applyTrackingStatus) {
    return directJsonp("orders", { session: adminSession() }).then(function (result) {
      if (!Array.isArray(result.orders)) throw new Error("INVALID_ORDERS");
      if (applyTrackingStatus === false) return result.orders;
      window.orders = result.orders;
      applyTrackedStatusesToCurrentOrders();
      window.renderOrders();
      return result.orders;
    });
  }

  function remoteOrderHasStatus(orderNumber, status) {
    return loadOrdersDirectly(false).then(function (orders) {
      return orders.some(function (order) {
        return String(order.orderNo) === String(orderNumber) && safe(order.status) === safe(status);
      });
    }).catch(function () {
      return false;
    });
  }

  function backendCompatibleStatus(status) {
    var value = safe(status);
    if (value === "تم التأكيد" || value === "جاري التجهيز") return "قيد التجهيز";
    if (value === "جاهز للاستلام" || value === "خرج للتوصيل") return "جاهز";
    return value;
  }

  function updateRemoteOrderStatus(orderNumber, status) {
    var remoteStatus = backendCompatibleStatus(status);
    var payload = {
      action: "updateStatus",
      orderNo: orderNumber,
      status: remoteStatus
    };
    var firstError = null;
    return window.gsPost(payload).then(function (response) {
      if (!response || !response.ok) throw new Error(response && response.error || "UPDATE_FAILED");
      return response;
    }).catch(function (error) {
      firstError = error;
      return wait(500).then(function () {
        return remoteOrderHasStatus(orderNumber, remoteStatus);
      }).then(function (alreadySaved) {
        if (alreadySaved) return { ok: true, recovered: true };
        return postWithoutCors(payload).then(function () {
          return wait(900);
        }).then(function () {
          return remoteOrderHasStatus(orderNumber, remoteStatus);
        }).then(function (saved) {
          if (!saved) throw firstError;
          return { ok: true, recovered: true };
        });
      });
    });
  }

  function readRemoteStatusCollection() {
    return directPublicRequest("products").then(function (result) {
      var bestMarker = null;
      (result.products || []).forEach(function (product) {
        if (safe(product.name).trim() !== STATUS_COLLECTION_MARKER) return;
        if (!bestMarker || Number(product.id || 0) >= Number(bestMarker.id || 0)) bestMarker = product;
      });
      if (!bestMarker) return { id: 0, collection: { version: 2, orders: {} } };
      try {
        return {
          id: Number(bestMarker.id || 0),
          collection: JSON.parse(safe(bestMarker.desc) || "{}")
        };
      } catch (error) {
        return { id: Number(bestMarker.id || 0), collection: { version: 2, orders: {} } };
      }
    });
  }

  function collectionIncludes(expectedOrders, remoteCollection) {
    var remoteOrders = remoteCollection && remoteCollection.orders || {};
    return Object.keys(expectedOrders || {}).every(function (number) {
      var expected = expectedOrders[number] || {};
      var remote = remoteOrders[number] || {};
      return safe(remote.status) === safe(expected.status) &&
        safe(remote.phoneHash) === safe(expected.phoneHash);
    });
  }

  function verifyRemoteStatusCollection(expectedOrders) {
    return readRemoteStatusCollection().then(function (remote) {
      if (!collectionIncludes(expectedOrders, remote.collection)) return false;
      statusCollectionMarkerId = remote.id || statusCollectionMarkerId;
      statusCollection = remote.collection;
      Object.keys(statusCollection.orders || {}).forEach(function (number) {
        statusMarkers[number] = {
          id: statusCollectionMarkerId,
          data: statusCollection.orders[number]
        };
      });
      return true;
    }).catch(function () {
      return false;
    });
  }

  function saveStatusCollection(expectedOrders) {
    var payload = {
        action: "saveProduct",
        id: statusCollectionMarkerId || 0,
        name: STATUS_COLLECTION_MARKER,
        desc: JSON.stringify(statusCollection),
        price: "",
        cat: "labneh",
        visible: false,
        imageData: "",
        existingImage: ""
      };
    var firstError = null;
    return window.gsPost(payload).then(function (response) {
      if (!response || !response.ok) throw new Error((response && response.error) || "STATUS_SYNC_FAILED");
      statusCollectionMarkerId = Number(response.id || response.productId || statusCollectionMarkerId || 0);
      return response;
    }).catch(function (error) {
      firstError = error;
      return wait(500).then(function () {
        return verifyRemoteStatusCollection(expectedOrders);
      }).then(function (alreadySaved) {
        if (alreadySaved) return { ok: true, recovered: true };
        return postWithoutCors(payload).then(function () {
          return wait(900);
        }).then(function () {
          return verifyRemoteStatusCollection(expectedOrders);
        }).then(function (saved) {
          if (!saved) throw firstError;
          return { ok: true, recovered: true };
        });
      });
    });
  }

  function savePublicStatus(orderNumber, status) {
    var order = (window.orders || []).find(function (item) {
      return String(item.orderNo) === String(orderNumber);
    });
    if (!order || !order.phone) return Promise.resolve();
    return phoneHash(order.phone).then(function (hash) {
      var number = String(orderNumber);
      var statusData = {
        orderNo: number,
        status: status,
        phoneHash: hash,
        deliveryType: order.deliveryType || "",
        updatedAt: new Date().toISOString()
      };
      statusCollection.orders = statusCollection.orders || {};
      statusCollection.orders[number] = statusData;
      statusMarkers[number] = {
        id: statusCollectionMarkerId,
        data: statusData
      };
      trimStatusCollection();
      var expected = {};
      expected[number] = statusData;
      return saveStatusCollection(expected);
    });
  }

  function ordersStatusSignature() {
    var value = (window.orders || []).map(function (order) {
      return [safe(order.orderNo), safe(order.status), digits(order.phone)].join("|");
    }).sort().join(";");
    var hash = 2166136261;
    for (var index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return value.length + "-" + (hash >>> 0).toString(16);
  }

  function setStatusSyncState(message, failed) {
    var state = document.getElementById("statusSyncState");
    if (!state) return;
    state.textContent = message || "";
    state.classList.toggle("failed", !!failed);
  }

  function buildStatusCollectionFromOrders() {
    var orders = (window.orders || []).filter(function (order) {
      return order && order.orderNo != null && digits(order.phone).length >= 8;
    }).sort(function (first, second) {
      return (Date.parse(second.dateISO) || Number(second.orderNo) || 0) -
        (Date.parse(first.dateISO) || Number(first.orderNo) || 0);
    }).slice(0, 100);
    return Promise.all(orders.map(function (order) {
      return phoneHash(order.phone).then(function (hash) {
        var number = String(order.orderNo);
        var old = statusCollection.orders && statusCollection.orders[number] || {};
        var status = safe(order.status || "جديد");
        return {
          number: number,
          data: {
            orderNo: number,
            status: status,
            phoneHash: hash,
            deliveryType: order.deliveryType || "",
            updatedAt: old.status === status && old.updatedAt
              ? old.updatedAt
              : new Date().toISOString()
          }
        };
      });
    })).then(function (entries) {
      statusCollection.orders = statusCollection.orders || {};
      entries.forEach(function (entry) {
        statusCollection.orders[entry.number] = entry.data;
        statusMarkers[entry.number] = {
          id: statusCollectionMarkerId,
          data: entry.data
        };
      });
      trimStatusCollection();
      var expected = {};
      entries.forEach(function (entry) {
        expected[entry.number] = entry.data;
      });
      return expected;
    });
  }

  window.syncOrderTrackingStatuses = function (showMessage) {
    var explicit = showMessage !== false;
    var button = document.getElementById("statusSyncButton");
    if (!(window.orders || []).length) {
      if (explicit) alert("لا توجد طلبات لمزامنتها.");
      return Promise.resolve(false);
    }
    if (button) {
      button.disabled = true;
      button.textContent = "جاري مزامنة التتبع...";
    }
    setStatusSyncState("جاري إرسال الحالات للزبائن...", false);
    statusSaveQueue = statusSaveQueue.then(function () {
      return buildStatusCollectionFromOrders();
    }).then(function (expected) {
      return saveStatusCollection(expected);
    }).then(function () {
      try { localStorage.setItem(STATUS_SYNC_SIGNATURE_KEY, ordersStatusSignature()); } catch (error) {}
      setStatusSyncState("تمت مزامنة حالات التتبع", false);
      if (explicit) alert("تمت مزامنة كل حالات الطلبات مع تتبّع الزبائن.");
      return true;
    }).catch(function (error) {
      console.error("Order tracking batch sync failed", error);
      setStatusSyncState("تعذّرت المزامنة — اضغط للمحاولة مرة أخرى", true);
      if (explicit) alert("تعذّرت مزامنة التتبع. تأكد من الإنترنت ثم حاول مرة أخرى.");
      return false;
    }).then(function (result) {
      if (button) {
        button.disabled = false;
        button.textContent = "🔄 مزامنة التتبع للزبائن";
      }
      return result;
    });
    return statusSaveQueue;
  };

  function autoSyncOrderStatuses(attempt) {
    var currentAttempt = Number(attempt || 0);
    if (!statusMarkersLoaded && currentAttempt < 5) {
      window.setTimeout(function () {
        autoSyncOrderStatuses(currentAttempt + 1);
      }, 500);
      return;
    }
    applyTrackedStatusesToCurrentOrders();
    window.renderOrders();
    var signature = ordersStatusSignature();
    var previous = "";
    try { previous = localStorage.getItem(STATUS_SYNC_SIGNATURE_KEY) || ""; } catch (error) {}
    if (!signature || signature === previous || !(window.orders || []).length) return;
    window.setTimeout(function () {
      window.syncOrderTrackingStatuses(false);
    }, 250);
  }

  window.loadCloudOrders = function () {
    var args = arguments;
    return loadOrdersDirectly().then(function (orders) {
      autoSyncOrderStatuses();
      return orders;
    }).catch(function (directError) {
      console.warn("Direct order loading fallback:", directError);
      var result = baseLoadCloudOrders.apply(window, args);
      return result && typeof result.then === "function" ? result : Promise.resolve(result);
    });
  };

  window.updateOrderStatus = function (number, status) {
    var order = (window.orders || []).find(function (item) {
      return String(item.orderNo) === String(number);
    });
    var oldStatus = order && order.status;
    if (order) order.status = status;
    window.renderOrders();
    setStatusSyncState("جاري تحديث الطلب #" + number + "...", false);
    statusSaveQueue = statusSaveQueue.then(function () {
      return savePublicStatus(number, status);
    }).then(function () {
      try { localStorage.setItem(STATUS_SYNC_SIGNATURE_KEY, ordersStatusSignature()); } catch (error) {}
      setStatusSyncState("تم تحديث الطلب والتتبّع", false);
      updateRemoteOrderStatus(number, status).catch(function (sheetError) {
        console.warn("Orders sheet status update deferred", sheetError);
      });
      return true;
    }).catch(function (trackingError) {
      console.error("Customer tracking sync failed", trackingError);
      setStatusSyncState("تعذّر حفظ حالة التتبّع — حاول مرة أخرى", true);
      alert("تعذّر حفظ حالة التتبّع. حاول اختيار الحالة مرة أخرى.");
      if (order && !statusMarkers[String(number)]) order.status = oldStatus;
      window.renderOrders();
      return false;
    });
    return statusSaveQueue;
  };

  window.renderOrders = function () {
    baseRenderOrders.apply(this, arguments);
    var statuses = ["جديد", "تم التأكيد", "جاري التجهيز", "جاهز للاستلام", "خرج للتوصيل", "تم التسليم", "ملغي"];
    Array.prototype.slice.call(document.querySelectorAll("#ordersBody .statusSelect")).forEach(function (select) {
      var changeHandler = safe(select.getAttribute("onchange"));
      var orderMatch = changeHandler.match(/updateOrderStatus\(([^,]+),/);
      var orderNumber = orderMatch ? safe(orderMatch[1]).replace(/['"\s]/g, "") : "";
      var order = (window.orders || []).find(function (item) {
        return String(item.orderNo) === orderNumber;
      });
      var currentStatus = safe(order && order.status || select.value || "جديد");
      if (currentStatus === "قيد التجهيز") currentStatus = "جاري التجهيز";
      if (currentStatus === "جاهز") {
        currentStatus = order && /delivery|توصيل/i.test(safe(order.deliveryType))
          ? "خرج للتوصيل"
          : "جاهز للاستلام";
      }
      if (order) order.status = currentStatus;
      select.innerHTML = statuses.map(function (status) {
        return '<option value="' + html(status) + '"' + (status === currentStatus ? " selected" : "") + '>' + html(status) + '</option>';
      }).join("");
      select.value = currentStatus;
    });
    var tools = document.querySelector("#ordersTab .ordersTools");
    if (tools && !document.getElementById("statusSyncButton")) {
      tools.insertAdjacentHTML("beforeend",
        '<button id="statusSyncButton" class="secondary" type="button" onclick="syncOrderTrackingStatuses(true)">🔄 مزامنة التتبع للزبائن</button>' +
        '<span id="statusSyncState" class="statusSyncState" aria-live="polite"></span>');
    }
  };

  function parseCoordinates(urlValue) {
    var value = safe(urlValue);
    var match = value.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/) ||
      value.match(/[?&](?:q|query)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    return match ? { lat: Number(match[1]), lng: Number(match[2]) } : null;
  }

  function distanceKm(first, second) {
    var radians = function (value) { return value * Math.PI / 180; };
    var earth = 6371;
    var deltaLat = radians(second.lat - first.lat);
    var deltaLng = radians(second.lng - first.lng);
    var a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
      Math.cos(radians(first.lat)) * Math.cos(radians(second.lat)) *
      Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
    return earth * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function branchCards(branches, position) {
    return branches.map(function (branch) {
      var coordinates = parseCoordinates(branch.map);
      var distance = position && coordinates ? distanceKm(position, coordinates) : null;
      return {
        branch: branch,
        distance: distance
      };
    }).sort(function (first, second) {
      if (first.distance == null && second.distance == null) return 0;
      if (first.distance == null) return 1;
      if (second.distance == null) return -1;
      return first.distance - second.distance;
    }).map(function (item, index) {
      return '<article class="branchCard"><b>' + (index === 0 && item.distance != null ? "⭐ " : "") + html(shown(item.branch.name)) + '</b>' +
        (item.branch.address ? '<div class="branchAddress">' + html(shown(item.branch.address)) + '</div>' : '') +
        (item.distance != null ? '<div class="muted">' + text("يبعد تقريبًا ", "About ") + item.distance.toFixed(1) + " " + text("كم", "km away") + '</div>' : '') +
        '<br><a href="' + html(item.branch.map) + '" target="_blank" rel="noopener">' + text("فتح الاتجاهات", "Open directions") + '</a></article>';
    }).join("");
  }

  window.openBranchesModal = function () {
    if (!enhancementConfig.branches.length) {
      var searchUrl = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent("غصن الزيتون للتجارة الإمارات");
      openEnhancementHtml('<h2>📍 ' + text("الفروع ونقاط البيع", "Branches and stores") + '</h2>' +
        '<div class="installHint">' + text("سيتم إضافة عناوين الفروع هنا من لوحة الإدارة. يمكنك الآن البحث عنها على خرائط Google.", "Branch addresses can be added from Admin. You can search Google Maps now.") + '</div>' +
        '<a class="primary" style="display:block;margin-top:12px;text-align:center;text-decoration:none" href="' + searchUrl + '" target="_blank" rel="noopener">' + text("البحث في خرائط Google", "Search Google Maps") + '</a>');
      return;
    }
    openEnhancementHtml('<h2>📍 ' + text("الفروع ونقاط البيع", "Branches and stores") + '</h2>' +
      '<button class="secondary" style="width:100%;margin-bottom:12px" type="button" onclick="findNearestBranch()">🎯 ' + text("رتّب حسب الأقرب لي", "Sort by nearest") + '</button>' +
      '<div id="branchList" class="branchList">' + branchCards(enhancementConfig.branches) + '</div>');
  };

  window.findNearestBranch = function () {
    var box = document.getElementById("branchList");
    if (!navigator.geolocation) {
      alert(text("تحديد الموقع غير مدعوم على هذا الجهاز.", "Location is not supported on this device."));
      return;
    }
    navigator.geolocation.getCurrentPosition(function (position) {
      if (box) box.innerHTML = branchCards(enhancementConfig.branches, {
        lat: position.coords.latitude,
        lng: position.coords.longitude
      });
    }, function () {
      alert(text("اسمح للمنيو باستخدام موقعك لعرض أقرب فرع.", "Allow location access to find the nearest branch."));
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  };

  window.installOliveMenu = function () {
    if (installPromptEvent) {
      installPromptEvent.prompt();
      installPromptEvent.userChoice.then(function () {
        installPromptEvent = null;
      });
      return;
    }
    var apple = /iPhone|iPad|iPod/i.test(safe(navigator.userAgent));
    var message = apple
      ? text("اضغط زر المشاركة في المتصفح ثم اختر «إضافة إلى الشاشة الرئيسية».", "Tap Share, then choose “Add to Home Screen”.")
      : text("افتح قائمة المتصفح واختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».", "Open the browser menu and choose “Install app” or “Add to Home screen”.");
    openEnhancementHtml('<h2>📱 ' + text("تثبيت المنيو", "Install menu") + '</h2><div class="installHint">' + html(message) + '</div>');
  };

  function translateEnhancementUi() {
    var labels = {
      favoritesService: ["المفضلة", "Favorites"],
      repeatService: ["إعادة الطلب", "Reorder"],
      trackingService: ["تتبّع الطلب", "Track order"],
      branchesService: ["الفروع", "Branches"],
      installService: ["تثبيت المنيو", "Install menu"]
    };
    Object.keys(labels).forEach(function (id) {
      var button = document.getElementById(id);
      var span = button && button.querySelector("span");
      if (span && !(id === "favoritesService" && favoriteOnly)) span.textContent = text(labels[id][0], labels[id][1]);
    });
    var map = {
      addressBookTitle: ["🚚 أين نوصل طلبك؟", "🚚 Where should we deliver?"],
      manageAddressButton: ["إدارة", "Manage"],
      chooseMapAddressButton: ["＋ إضافة عنوان توصيل جديد", "＋ Add a new delivery address"],
      addressBookHint: ["احفظ أكثر من عنوان واختره بلمسة واحدة.", "Save multiple addresses and choose one with a tap."],
      gpsButton: ["📍 توصيل لموقعي الحالي الآن", "📍 Deliver to my current location now"],
      deliveryScheduleTitle: ["موعد التوصيل والكوبون", "Delivery time and coupon"],
      deliveryDateLabel: ["تاريخ التوصيل", "Delivery date"],
      deliverySlotLabel: ["الفترة المناسبة", "Preferred time"],
      deliveryMinimumHint: ["أقرب موعد توصيل متاح بعد 3 أيام من تاريخ الطلب.", "The earliest available delivery date is 3 days after ordering."],
      couponLabel: ["كود الخصم", "Discount code"],
      couponApplyButton: ["تطبيق", "Apply"]
    };
    Object.keys(map).forEach(function (id) {
      var element = document.getElementById(id);
      if (element) element.textContent = text(map[id][0], map[id][1]);
    });
    var couponInput = document.getElementById("couponCode");
    if (couponInput) couponInput.placeholder = text("اكتب الكود", "Enter code");
    renderSavedAddressOptions();
    renderOffers();
    updateFavoriteButton();
  }

  window.setMenuLanguage = function (language) {
    var result = baseSetMenuLanguage.apply(this, arguments);
    refreshEnhancementUi();
    window.render();
    window.renderCart();
    return result;
  };

  window.addEventListener("beforeinstallprompt", function (event) {
    event.preventDefault();
    installPromptEvent = event;
    var button = document.getElementById("installService");
    if (button) button.hidden = false;
  });

  window.addEventListener("appinstalled", function () {
    installPromptEvent = null;
    var button = document.getElementById("installService");
    if (button) button.hidden = true;
  });

  if (navigator.serviceWorker && typeof navigator.serviceWorker.register === "function") {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).catch(function () {
        return navigator.serviceWorker.register("./sw.js");
      }).then(function (registration) {
        return registration.update();
      }).catch(function (error) {
        console.warn("Service worker registration failed", error);
      });
    });
  }

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") window.closeEnhancementModal();
  });

  document.addEventListener("change", function (event) {
    if (event.target && (event.target.id === "area" || event.target.name === "deliveryType")) {
      window.renderCart();
    }
  });

  document.addEventListener("input", function (event) {
    if (!applyingSavedAddress && event.target && event.target.id === "area" && selectedAddressId) {
      setSelectedAddressId("");
      renderSavedAddressOptions();
    }
  });

  injectCustomerUi();
  injectAdminUi();
  renderDeliveryOptions();
  renderOffers();
  translateEnhancementUi();
  window.render();
  window.renderCart();
})();
