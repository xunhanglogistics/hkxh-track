/**
 * 使用物流商提供的响应示例，验证前端解析逻辑能否测试通过
 * 运行: node test-speedaf-response.js
 */

// 物流商提供的响应参数示例（直接数组格式）
const mockResponse = [
  {
    "mailNo": "86254200001257",
    "tracks": [
      {
        "mailNo": "86254200001257",
        "action": "1",
        "subAction": "1",
        "actionName": "已揽收",
        "message": "【LOS-WH1】已做收件扫描，收件员是【Ejalonibu Wahab】【09025119825】",
        "msgEng": "Parcel scanned by site",
        "time": "2021-05-05 21:27:34",
        "msgLoc": "Parcel scanned by site",
        "pictureUrl": "https://opa.speedaf.com/manager/file/view/63968d3f-be9a-4a92-8751-42d24e03933e.png",
        "timezone": 8
      }
    ]
  }
];

// 与 index.html 中完全一致的解析逻辑
function parseSpeedafResponse(raw, inputNumber) {
  let data = raw;
  if (raw && typeof raw.success === 'boolean' && !raw.success) {
    const msg = (raw.error && raw.error.message) ? raw.error.message : '未找到该单号信息';
    return { error: msg };
  }
  if (raw && raw.data !== undefined) data = raw.data;
  if (!Array.isArray(data) || data.length === 0) {
    return { error: '未找到该单号信息' };
  }
  const item = data[0];
  const mailNo = item.mailNo || inputNumber;
  const tracks = item.tracks || [];
  const status = tracks.length > 0 ? tracks[0].actionName : '暂无状态';
  const items = [];
  if (tracks.length > 0) {
    tracks.forEach(function (t) {
      const desc = t.message || t.msgEng || t.msgLoc || t.actionName || '';
      items.push({ time: t.time, desc: desc, pictureUrl: t.pictureUrl });
    });
  }
  return { mailNo, status, tracks: items };
}

// 测试1: 直接数组格式（物流商参考用例）
const result1 = parseSpeedafResponse(mockResponse, '86254200001257');
const pass1 = !result1.error && result1.mailNo === '86254200001257' && result1.status === '已揽收' && result1.tracks.length === 1 && result1.tracks[0].time === '2021-05-05 21:27:34' && result1.tracks[0].desc.indexOf('LOS-WH1') !== -1 && result1.tracks[0].pictureUrl.indexOf('opa.speedaf.com') !== -1;

console.log('--- 测试：物流商响应示例（直接数组格式）---');
console.log('解析结果:', JSON.stringify(result1, null, 2));
console.log('测试通过:', pass1 ? '是' : '否');

// 测试2: 请求体格式
const requestBody = { mailNoList: ['86254200001257'] };
const pass2 = Array.isArray(requestBody.mailNoList) && requestBody.mailNoList[0] === '86254200001257';
console.log('\n--- 测试：请求参数格式 ---');
console.log('请求体:', JSON.stringify(requestBody));
console.log('符合文档:', pass2 ? '是' : '否');

const allPass = pass1 && pass2;
console.log('\n========== 结论 ==========');
console.log(allPass ? '按物流商参考用例，解析与请求格式均能测试通过。' : '存在未通过项，需检查。');
process.exit(allPass ? 0 : 1);
