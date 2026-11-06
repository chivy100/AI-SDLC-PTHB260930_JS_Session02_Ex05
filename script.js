
// 1. HÀM THỬ LẠI KHI GẶP LỖI TẠM THỜI

async function withRetry(task, { retries = 2, delayMs = 0 } = {}) {
  // Lưu lỗi cuối cùng để ném ra khi đã hết số lần thử.
  let lastError;

  // retries là số lần thử lại, không tính lần gọi đầu tiên.
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Thực thi task và trả kết quả nếu thành công.
      return await task();
    } catch (error) {
      lastError = error;

      // Chỉ thử lại khi lỗi thuộc nhóm được phép.
      const isRetryable =
        error instanceof ApiError &&
        (
          error.status === 0 ||
          error.status === 408 ||
          (error.status >= 500 && error.status <= 599)
        );

      // Lỗi không được thử lại hoặc đã hết lượt thì ném lỗi.
      if (!isRetryable || attempt === retries) {
        throw error;
      }

      // Chờ delayMs trước khi thực hiện lần thử tiếp theo.
      await delay(delayMs);
    }
  }

  // Ném lỗi cuối cùng nếu tất cả lần thử đều thất bại.
  throw lastError;
}


// 2. HÀM GỌI API CÓ GIỚI HẠN THỜI GIAN

async function fetchWithTimeout(url, ms, options = {}) {
  // Tạo controller để có thể hủy request.
  const controller = new AbortController();

  // Xác định request có bị hủy do quá thời gian hay không.
  let timedOut = false;

  // Tạo bộ đếm thời gian để hủy request khi quá ms.
  const timerId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);

  try {
    // Gửi request kèm signal để AbortController kiểm soát.
    return await request(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    // Chuyển lỗi do timeout thành ApiError có status 408.
    if (timedOut) {
      throw new ApiError(
        408,
        `Yêu cầu quá thời gian chờ ${ms}ms.`,
        null
      );
    }

    // Các lỗi khác giữ nguyên để tầng xử lý bên ngoài tiếp nhận.
    throw error;
  } finally {
    // Xóa bộ đếm khi request hoàn thành hoặc thất bại.
    clearTimeout(timerId);
  }
}


// 3. HÀM LẤY TOÀN BỘ DỮ LIỆU QUA PHÂN TRANG

async function fetchAllPages(path, { key, pageSize = 100 } = {}) {
  // Kiểm tra pageSize phải là số nguyên dương.
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new ApiError(
      400,
      "pageSize phải là số nguyên dương.",
      null
    );
  }

  // Kiểm tra tên trường chứa danh sách dữ liệu.
  if (typeof key !== "string" || key.trim() === "") {
    throw new ApiError(
      400,
      "Tên trường dữ liệu không hợp lệ.",
      null
    );
  }

  // Mảng lưu toàn bộ dữ liệu lấy được từ các trang.
  const allItems = [];

  // Tổng số phần tử do server cung cấp.
  let total = Infinity;

  // Tiếp tục lấy trang khi chưa đủ số lượng dữ liệu.
  while (allItems.length < total) {
    // skip bằng số phần tử đã lấy được.
    const response = await request(path, {
      params: {
        limit: pageSize,
        skip: allItems.length
      }
    });

    // Lấy danh sách dữ liệu theo key được truyền vào.
    const pageItems = response?.[key];

    // Trang không có dữ liệu hợp lệ thì dừng để tránh lặp vô hạn.
    if (!Array.isArray(pageItems) || pageItems.length === 0) {
      break;
    }

    // Gộp dữ liệu của trang hiện tại vào mảng kết quả.
    allItems.push(...pageItems);

    // Cập nhật tổng số phần tử theo thông tin từ server.
    if (Number.isFinite(response.total) && response.total >= 0) {
      total = response.total;
    } else {
      // Không có total thì không thể xác định chính xác số trang.
      throw new ApiError(
        500,
        "Phản hồi phân trang thiếu tổng số dữ liệu hợp lệ.",
        response
      );
    }

    // Dừng khi đã lấy đủ số phần tử server thông báo.
    if (allItems.length >= total) {
      break;
    }
  }

  // Trả về mảng dữ liệu đã gộp từ các trang.
  return allItems;
}


// 4. HÀM TẢI DỮ LIỆU DASHBOARD

async function loadDashboard({
  timeoutMs = 3000,
  retries = 1,
  delayMs = 0
} = {}) {
  // Gọi ba khối dữ liệu đồng thời và chờ tất cả hoàn thành.
  const results = await Promise.allSettled([
    loadDashboardBlock(
      "/products/categories",
      timeoutMs,
      retries,
      delayMs,
      {},
      (response) => response.map((category) => category.name)
    ),

    loadDashboardBlock(
      "/products",
      timeoutMs,
      retries,
      delayMs,
      {
        params: {
          limit: 5,
          sortBy: "rating",
          order: "desc",
          select: "title,price,rating"
        }
      },
      (response) => response.products
    ),

    loadDashboardBlock(
      "/carts",
      timeoutMs,
      retries,
      delayMs,
      {
        params: {
          limit: 3
        }
      },
      (response) => ({
        totalCarts: response.total,
        latest: response.carts.map((cart) => ({
          id: cart.id,
          userId: cart.userId,
          totalQuantity: cart.totalQuantity
        }))
      })
    )
  ]);

  // Khởi tạo kết quả mặc định cho ba khối.
  const dashboard = {
    categories: null,
    topProducts: null,
    cartSummary: null,
    errors: {}
  };

  // Danh sách tên tương ứng với thứ tự ba Promise.
  const blockNames = [
    "categories",
    "topProducts",
    "cartSummary"
  ];

  // Xử lý độc lập kết quả thành công hoặc thất bại của từng khối.
  results.forEach((result, index) => {
    const blockName = blockNames[index];

    if (result.status === "fulfilled") {
      // Khối thành công nhận dữ liệu tương ứng.
      dashboard[blockName] = result.value;
    } else {
      // Khối thất bại giữ giá trị null và lưu thông báo lỗi.
      dashboard[blockName] = null;
      dashboard.errors[blockName] =
        result.reason?.message || "Đã xảy ra lỗi không xác định.";
    }
  });

  // Luôn trả về kết quả tổng hợp, kể cả khi cả ba khối lỗi.
  return dashboard;
}


// 5. TEST CASE: withRetry()

// Đổi false thành true nếu muốn chạy các test thủ công.
// Các test được tắt mặc định để không ảnh hưởng tests.html.
if (false) {
  (async function runManualTests() {

    console.log("===== TEST withRetry() =====");

    // Kiểm tra lần đầu lỗi 500, lần thứ ba thành công.
    let retryCount = 0;

    const retryResult = await withRetry(async () => {
      retryCount++;

      if (retryCount < 3) {
        throw new ApiError(500, "Server Error", null);
      }

      return "Success";
    }, {
      retries: 2,
      delayMs: 100
    });

    console.log(retryResult);
    // Expected: "Success"

    console.log(retryCount);
    // Expected: 3

    // Kiểm tra lỗi 404 không được thử lại.
    let notFoundCount = 0;

    try {
      await withRetry(async () => {
        notFoundCount++;
        throw new ApiError(404, "Not Found", null);
      }, {
        retries: 2,
        delayMs: 100
      });
    } catch (error) {
      console.log(error.status);
      // Expected: 404

      console.log(notFoundCount);
      // Expected: 1
    }

    // Kiểm tra hết số lần thử lại khi liên tục gặp lỗi 500.
    let failedCount = 0;

    try {
      await withRetry(async () => {
        failedCount++;
        throw new ApiError(500, "Server Error", null);
      }, {
        retries: 2,
        delayMs: 100
      });
    } catch (error) {
      console.log(error.message);
      // Expected: "Server Error"

      console.log(failedCount);
      // Expected: 3
    }


    // 6. TEST CASE: fetchWithTimeout()

    console.log("===== TEST fetchWithTimeout() =====");

    // Kiểm tra request thành công trước thời gian timeout.
    try {
      const productResponse = await fetchWithTimeout(
        "/products?limit=5",
        3000
      );

      console.log(productResponse.products.length);
      // Expected: 5
    } catch (error) {
      console.log(error.message);
    }

    // Kiểm tra request vượt quá thời gian chờ.
    try {
      await fetchWithTimeout("/products?limit=100", 1);
    } catch (error) {
      console.log(error.status);
      // Expected: 408 nếu request chưa hoàn thành sau 1ms.

      console.log(error.message);
      // Expected: "Yêu cầu quá thời gian chờ 1ms."
    }


    // 7. TEST CASE: fetchAllPages()

    console.log("===== TEST fetchAllPages() =====");

    // Kiểm tra lấy toàn bộ 194 sản phẩm với pageSize bằng 50.
    try {
      const allProducts = await fetchAllPages("/products", {
        key: "products",
        pageSize: 50
      });

      console.log(allProducts.length);
      // Expected: 194 theo dữ liệu API của đề bài.
    } catch (error) {
      console.log(error.message);
    }

    // Kiểm tra pageSize lớn hơn tổng số sản phẩm.
    try {
      const products = await fetchAllPages("/products", {
        key: "products",
        pageSize: 200
      });

      console.log(products.length);
      // Expected: 194

      // Expected: Chỉ có một request với limit=200 và skip=0.
    } catch (error) {
      console.log(error.message);
    }

    // Kiểm tra pageSize không hợp lệ.
    try {
      await fetchAllPages("/products", {
        key: "products",
        pageSize: 0
      });
    } catch (error) {
      console.log(error.status);
      // Expected: 400
    }


    // 8. TEST CASE: loadDashboard()

    console.log("===== TEST loadDashboard() =====");

    // Kiểm tra ba khối Dashboard khi API hoạt động bình thường.
    const dashboard = await loadDashboard();

    console.log(dashboard.categories.length);
    // Expected: 24 theo dữ liệu API của đề bài.

    console.log(dashboard.topProducts.length);
    // Expected: 5

    console.log(Object.keys(dashboard.errors));
    // Expected: []

    // Kiểm tra cấu trúc kết quả của khối cartSummary.
    console.log(Object.keys(dashboard.cartSummary));
    // Expected: ["totalCarts", "latest"]

  })().catch((error) => {
    console.error("Lỗi khi chạy TEST CASE:", error);
  });
}


// 9. HÀM PHỤ: TẢI MỘT KHỐI DASHBOARD

async function loadDashboardBlock(
  url,
  timeoutMs,
  retries,
  delayMs,
  options,
  transform
) {
  // Kết hợp retry và timeout cho từng yêu cầu.
  const response = await withRetry(
    () => fetchWithTimeout(url, timeoutMs, options),
    {
      retries,
      delayMs
    }
  );

  // Chuyển dữ liệu API thành cấu trúc mà Dashboard cần.
  return transform(response);
}
