(function () {
  "use strict";

  var PDF_WIDTH = 1240;
  var PDF_HEIGHT = 1754;
  var ITEMS_PER_PAGE = 5;
  var pendingWhatsAppWindow = null;
  var lastOrder = null;
  var lastPdfBlob = null;
  var lastPdfUrl = "";
  var lastPdfName = "";
  var buildSequence = 0;

  function byId(id) {
    return document.getElementById(id);
  }

  function isEnglish() {
    return document.documentElement.lang === "en";
  }

  function setText(id, arabic, english) {
    var element = byId(id);
    if (element) element.textContent = isEnglish() ? english : arabic;
  }

  function safeText(value, fallback) {
    var text = String(value == null ? "" : value).trim();
    return text || fallback || "-";
  }

  function amount(value) {
    return Number(value || 0).toFixed(2).replace(/\.00$/, "");
  }

  function productNames(value) {
    var parts = safeText(value).split(/\s*\|\|\s*|\s+\|\s+/);
    return {
      ar: safeText(parts[0], "-"),
      en: safeText(parts[1], parts[0] || "-")
    };
  }

  function paymentLabel(value) {
    if (value === "bank") return { ar: "تحويل بنكي", en: "Bank transfer" };
    if (value === "visa") return { ar: "فيزا / بطاقة", en: "Visa / Card" };
    return { ar: "نقدًا", en: "Cash" };
  }

  function receiptFileName(order) {
    return "Olive-Branch-Order-" + safeText(order.orderNo, "receipt").replace(/[^\w-]+/g, "-") + ".pdf";
  }

  function updateModalLanguage() {
    setText("thankYouTitle", "شكرًا على طلبكم من غصن الزيتون للتجارة", "Thank you for ordering from Olive Branch Trading");
    setText("thankYouSubtitle", "تم تسجيل طلبكم بنجاح، وهذه فاتورة طلبكم بالصور.", "Your order was recorded successfully. Your illustrated receipt is below.");
    setText("receiptDownloadButton", "تنزيل فاتورة PDF", "Download PDF receipt");
    setText("receiptShareButton", "مشاركة فاتورة PDF", "Share PDF receipt");
    setText("receiptWhatsappButton", "فتح واتساب لإرسال الطلب", "Open WhatsApp to send order");
    setText("receiptCloseButton", "العودة إلى المنيو", "Back to menu");
  }

  function setReceiptStatus(arabic, english) {
    setText("receiptStatus", arabic, english);
  }

  function setReceiptButtonsReady(ready) {
    var downloadButton = byId("receiptDownloadButton");
    var shareButton = byId("receiptShareButton");
    if (downloadButton) downloadButton.disabled = !ready;
    if (shareButton) shareButton.disabled = !ready;
  }

  function showThankYou(order, whatsappOpened) {
    updateModalLanguage();
    var orderNumber = byId("thankYouOrderNo");
    if (orderNumber) {
      orderNumber.textContent = isEnglish()
        ? "Order #" + safeText(order.orderNo)
        : "رقم الطلب #" + safeText(order.orderNo);
    }
    setReceiptButtonsReady(false);
    setReceiptStatus("جاري تجهيز فاتورة PDF بالصور...", "Preparing your illustrated PDF receipt...");
    var whatsappButton = byId("receiptWhatsappButton");
    if (whatsappButton) {
      whatsappButton.textContent = whatsappOpened
        ? (isEnglish() ? "Open WhatsApp again" : "فتح واتساب مرة أخرى")
        : (isEnglish() ? "Open WhatsApp to send order" : "فتح واتساب لإرسال الطلب");
    }
    var modal = byId("thankYouModal");
    if (modal) modal.classList.add("open");
  }

  function closePendingWhatsApp() {
    if (pendingWhatsAppWindow && !pendingWhatsAppWindow.closed) {
      try {
        pendingWhatsAppWindow.close();
      } catch (error) {}
    }
    pendingWhatsAppWindow = null;
  }

  function prepareWhatsAppWindow() {
    closePendingWhatsApp();
  }

  function openPreparedWhatsApp(url) {
    if (!url) return false;
    window.setTimeout(function () {
      window.location.assign(url);
    }, 50);
    return true;
  }

  function loadImageFromUrl(url) {
    return new Promise(function (resolve) {
      var source = safeText(url, "");
      if (!source) {
        resolve(null);
        return;
      }

      var completed = false;
      var objectUrl = "";
      var timeout = window.setTimeout(function () {
        finish(null);
      }, 9000);

      function finish(image) {
        if (completed) return;
        completed = true;
        window.clearTimeout(timeout);
        if (objectUrl) {
          window.setTimeout(function () {
            URL.revokeObjectURL(objectUrl);
          }, 1000);
        }
        resolve(image || null);
      }

      function loadSource(imageSource) {
        var image = new Image();
        image.onload = function () { finish(image); };
        image.onerror = function () { finish(null); };
        image.src = imageSource;
      }

      if (/^data:image\//i.test(source) || source.indexOf(location.origin) === 0 || source.charAt(0) === "/") {
        loadSource(source);
        return;
      }

      fetch(source, { mode: "cors", cache: "force-cache", credentials: "omit" })
        .then(function (response) {
          if (!response.ok) throw new Error("IMAGE_HTTP_" + response.status);
          return response.blob();
        })
        .then(function (blob) {
          objectUrl = URL.createObjectURL(blob);
          loadSource(objectUrl);
        })
        .catch(function () {
          finish(null);
        });
    });
  }

  function roundedRect(context, x, y, width, height, radius) {
    var r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.lineTo(x + width - r, y);
    context.quadraticCurveTo(x + width, y, x + width, y + r);
    context.lineTo(x + width, y + height - r);
    context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    context.lineTo(x + r, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - r);
    context.lineTo(x, y + r);
    context.quadraticCurveTo(x, y, x + r, y);
    context.closePath();
  }

  function drawImageCover(context, image, x, y, width, height) {
    if (!image || !image.naturalWidth || !image.naturalHeight) return false;
    var imageRatio = image.naturalWidth / image.naturalHeight;
    var boxRatio = width / height;
    var sourceWidth = image.naturalWidth;
    var sourceHeight = image.naturalHeight;
    var sourceX = 0;
    var sourceY = 0;
    if (imageRatio > boxRatio) {
      sourceWidth = image.naturalHeight * boxRatio;
      sourceX = (image.naturalWidth - sourceWidth) / 2;
    } else {
      sourceHeight = image.naturalWidth / boxRatio;
      sourceY = (image.naturalHeight - sourceHeight) / 2;
    }
    context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
    return true;
  }

  function drawWrappedText(context, text, x, y, maxWidth, lineHeight, maxLines) {
    var words = safeText(text).split(/\s+/);
    var lines = [];
    var line = "";
    words.forEach(function (word) {
      var test = line ? line + " " + word : word;
      if (context.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    });
    if (line) lines.push(line);
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      var last = lines[maxLines - 1];
      while (last.length > 1 && context.measureText(last + "…").width > maxWidth) {
        last = last.slice(0, -1);
      }
      lines[maxLines - 1] = last + "…";
    }
    lines.forEach(function (value, index) {
      context.fillText(value, x, y + index * lineHeight);
    });
  }

  function createCanvas() {
    var canvas = document.createElement("canvas");
    canvas.width = PDF_WIDTH;
    canvas.height = PDF_HEIGHT;
    return canvas;
  }

  function drawReceiptPage(order, itemImages, logo, pageIndex, pageCount) {
    var canvas = createCanvas();
    var context = canvas.getContext("2d");
    var pageItems = order.items.slice(pageIndex * ITEMS_PER_PAGE, (pageIndex + 1) * ITEMS_PER_PAGE);
    var firstItemIndex = pageIndex * ITEMS_PER_PAGE;
    var isLastPage = pageIndex === pageCount - 1;
    var green = "#285b35";
    var gold = "#c9a46a";
    var cream = "#f7f1e7";
    var text = "#223126";
    var muted = "#6b746d";

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, PDF_WIDTH, PDF_HEIGHT);
    context.fillStyle = green;
    context.fillRect(0, 0, PDF_WIDTH, 24);
    context.fillStyle = cream;
    context.fillRect(0, 24, PDF_WIDTH, 292);

    if (logo) {
      context.drawImage(logo, PDF_WIDTH / 2 - 82, 48, 164, 164);
    }
    context.textAlign = "center";
    context.direction = "rtl";
    context.fillStyle = green;
    context.font = "bold 42px Tahoma, Arial, sans-serif";
    context.fillText("غصن الزيتون للتجارة", PDF_WIDTH / 2, 246);
    context.direction = "ltr";
    context.fillStyle = "#9b6817";
    context.font = "bold 24px Arial, sans-serif";
    context.fillText("OLIVE BRANCH TRADING", PDF_WIDTH / 2, 282);

    roundedRect(context, 56, 338, PDF_WIDTH - 112, 120, 24);
    context.fillStyle = "#f9f6ef";
    context.fill();
    context.strokeStyle = "#e3d3b8";
    context.lineWidth = 2;
    context.stroke();

    context.textAlign = "right";
    context.direction = "rtl";
    context.fillStyle = text;
    context.font = "bold 25px Tahoma, Arial, sans-serif";
    context.fillText("فاتورة الطلب رقم #" + safeText(order.orderNo), PDF_WIDTH - 86, 382);
    context.font = "21px Tahoma, Arial, sans-serif";
    context.fillText("العميل: " + safeText(order.record && order.record.name), PDF_WIDTH - 86, 422);

    context.textAlign = "left";
    context.direction = "ltr";
    context.font = "bold 23px Arial, sans-serif";
    context.fillText("Order #" + safeText(order.orderNo), 86, 382);
    context.font = "20px Arial, sans-serif";
    context.fillText(safeText(order.record && order.record.dateText), 86, 422);

    var startY = 488;
    var rowHeight = 184;
    pageItems.forEach(function (item, index) {
      var y = startY + index * rowHeight;
      var names = productNames(item.name);
      var image = itemImages[firstItemIndex + index];

      roundedRect(context, 56, y, PDF_WIDTH - 112, 164, 22);
      context.fillStyle = index % 2 ? "#ffffff" : "#fbf8f2";
      context.fill();
      context.strokeStyle = "#eadfcd";
      context.lineWidth = 2;
      context.stroke();

      roundedRect(context, PDF_WIDTH - 236, y + 12, 144, 140, 16);
      context.save();
      context.clip();
      context.fillStyle = "#edf2ed";
      context.fillRect(PDF_WIDTH - 236, y + 12, 144, 140);
      if (!drawImageCover(context, image, PDF_WIDTH - 236, y + 12, 144, 140)) {
        context.fillStyle = green;
        context.textAlign = "center";
        context.direction = "rtl";
        context.font = "bold 50px Tahoma, Arial, sans-serif";
        context.fillText(names.ar.charAt(0) || "غ", PDF_WIDTH - 164, y + 100);
      }
      context.restore();

      context.fillStyle = text;
      context.textAlign = "right";
      context.direction = "rtl";
      context.font = "bold 27px Tahoma, Arial, sans-serif";
      drawWrappedText(context, names.ar, PDF_WIDTH - 266, y + 50, 600, 34, 2);
      context.fillStyle = muted;
      context.direction = "ltr";
      context.font = "20px Arial, sans-serif";
      context.fillText(names.en, PDF_WIDTH - 266, y + 116);

      context.textAlign = "left";
      context.direction = "rtl";
      context.fillStyle = green;
      context.font = "bold 25px Tahoma, Arial, sans-serif";
      context.fillText("الكمية: " + amount(item.qty), 82, y + 54);
      context.direction = "ltr";
      context.font = "bold 22px Arial, sans-serif";
      context.fillText(amount(Number(item.price || 0) * Number(item.qty || 0)) + " AED", 82, y + 108);
    });

    if (isLastPage) {
      var totalY = startY + pageItems.length * rowHeight + 8;
      var payment = paymentLabel(order.paymentMethod);
      roundedRect(context, 56, totalY, PDF_WIDTH - 112, 224, 24);
      context.fillStyle = green;
      context.fill();

      context.fillStyle = "#ffffff";
      context.textAlign = "right";
      context.direction = "rtl";
      context.font = "23px Tahoma, Arial, sans-serif";
      context.fillText("الإجمالي قبل التوصيل", PDF_WIDTH - 86, totalY + 50);
      context.fillText("رسوم التوصيل", PDF_WIDTH - 86, totalY + 90);
      if (Number(order.totals.discount || 0)) context.fillText("الخصم", PDF_WIDTH - 86, totalY + 130);
      context.font = "bold 32px Tahoma, Arial, sans-serif";
      context.fillText("الإجمالي النهائي", PDF_WIDTH - 86, totalY + 184);

      context.textAlign = "left";
      context.direction = "ltr";
      context.font = "22px Arial, sans-serif";
      context.fillText(amount(order.totals.subtotal) + " AED", 86, totalY + 50);
      context.fillText(amount(order.totals.delivery) + " AED", 86, totalY + 90);
      if (Number(order.totals.discount || 0)) context.fillText("-" + amount(order.totals.discount) + " AED", 86, totalY + 130);
      context.font = "bold 34px Arial, sans-serif";
      context.fillText(amount(order.totals.total) + " AED", 86, totalY + 184);

      context.fillStyle = gold;
      context.textAlign = "center";
      context.direction = "rtl";
      context.font = "bold 20px Tahoma, Arial, sans-serif";
      context.fillText("طريقة الدفع: " + payment.ar + "  |  " + payment.en, PDF_WIDTH / 2, totalY + 214);
    }

    context.fillStyle = green;
    context.textAlign = "center";
    context.direction = "rtl";
    context.font = "bold 22px Tahoma, Arial, sans-serif";
    context.fillText("شكرًا على طلبكم من غصن الزيتون للتجارة", PDF_WIDTH / 2, PDF_HEIGHT - 58);
    context.direction = "ltr";
    context.fillStyle = muted;
    context.font = "18px Arial, sans-serif";
    context.fillText("Page " + (pageIndex + 1) + " / " + pageCount, PDF_WIDTH / 2, PDF_HEIGHT - 26);
    return canvas;
  }

  function buildReceiptPdf(order) {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      return Promise.reject(new Error("PDF_LIBRARY_NOT_READY"));
    }
    var logoPromise = loadImageFromUrl(new URL("icon-512.png", location.href).href);
    var imagePromises = order.items.map(function (item) {
      return loadImageFromUrl(item.image || "");
    });
    return Promise.all([logoPromise, Promise.all(imagePromises)]).then(function (loaded) {
      var logo = loaded[0];
      var itemImages = loaded[1];
      var pageCount = Math.max(1, Math.ceil(order.items.length / ITEMS_PER_PAGE));
      var jsPDF = window.jspdf.jsPDF;
      var pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4", compress: true });
      for (var pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
        if (pageIndex) pdf.addPage("a4", "portrait");
        var canvas = drawReceiptPage(order, itemImages, logo, pageIndex, pageCount);
        pdf.addImage(canvas.toDataURL("image/jpeg", 0.9), "JPEG", 0, 0, 595.28, 841.89, undefined, "FAST");
      }
      pdf.setProperties({
        title: "Olive Branch Trading Order #" + safeText(order.orderNo),
        subject: "Customer order receipt",
        author: "Olive Branch Trading",
        creator: "Olive Branch Menu"
      });
      return pdf.output("blob");
    });
  }

  function prepareReceipt(order) {
    var sequence = ++buildSequence;
    if (lastPdfUrl) {
      URL.revokeObjectURL(lastPdfUrl);
      lastPdfUrl = "";
    }
    lastPdfBlob = null;
    lastPdfName = receiptFileName(order);
    buildReceiptPdf(order).then(function (blob) {
      if (sequence !== buildSequence) return;
      lastPdfBlob = blob;
      lastPdfUrl = URL.createObjectURL(blob);
      setReceiptButtonsReady(true);
      setReceiptStatus("فاتورة PDF جاهزة بالصور ويمكن تنزيلها أو مشاركتها.", "Your illustrated PDF receipt is ready to download or share.");
    }).catch(function (error) {
      console.error("Receipt PDF failed", error);
      if (sequence !== buildSequence) return;
      setReceiptButtonsReady(false);
      setReceiptStatus("تعذر تجهيز PDF الآن. الطلب تم تسجيله ويمكن فتح واتساب بصورة طبيعية.", "The PDF could not be prepared now. Your order is still recorded and WhatsApp is available.");
    });
  }

  window.beginCustomerOrderReceiptFlow = function () {
    prepareWhatsAppWindow();
  };

  window.cancelCustomerOrderReceiptFlow = function () {
    closePendingWhatsApp();
  };

  window.completeCustomerOrderReceiptFlow = function (order) {
    if (!order || !order.items || !order.items.length) return false;
    lastOrder = order;
    var whatsappOpened = openPreparedWhatsApp(order.whatsappUrl);
    showThankYou(order, whatsappOpened);
    prepareReceipt(order);
    return true;
  };

  window.closeThankYouModal = function () {
    var modal = byId("thankYouModal");
    if (modal) modal.classList.remove("open");
  };

  window.openLastOrderWhatsApp = function () {
    if (!lastOrder || !lastOrder.whatsappUrl) return;
    window.location.assign(lastOrder.whatsappUrl);
  };

  window.downloadLastOrderPdf = function () {
    if (!lastPdfBlob || !lastPdfUrl) {
      setReceiptStatus("الفاتورة ما زالت قيد التجهيز...", "Your receipt is still being prepared...");
      return;
    }
    var link = document.createElement("a");
    link.href = lastPdfUrl;
    link.download = lastPdfName || "Olive-Branch-Order.pdf";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  window.shareLastOrderPdf = function () {
    if (!lastPdfBlob) {
      setReceiptStatus("الفاتورة ما زالت قيد التجهيز...", "Your receipt is still being prepared...");
      return;
    }
    var file;
    try {
      file = new File([lastPdfBlob], lastPdfName || "Olive-Branch-Order.pdf", { type: "application/pdf" });
    } catch (error) {
      window.downloadLastOrderPdf();
      return;
    }
    if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
      navigator.share({
        title: isEnglish() ? "Olive Branch Trading order" : "طلب غصن الزيتون للتجارة",
        text: isEnglish() ? "My order receipt from Olive Branch Trading" : "فاتورة طلبي من غصن الزيتون للتجارة",
        files: [file]
      }).catch(function (error) {
        if (error && error.name !== "AbortError") window.downloadLastOrderPdf();
      });
    } else {
      window.downloadLastOrderPdf();
      setReceiptStatus("تم تنزيل الفاتورة؛ يمكنك إرفاقها من التنزيلات.", "The receipt was downloaded and can be attached from your downloads.");
    }
  };

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") window.closeThankYouModal();
  });
})();
