// (project, page_number) 有唯一索引。升序单遍：目标序号恒 ≤ 当前序号，
// 且不会撞上尚未处理行的旧序号，无需两遍腾挪；未变化的行不写。
function renumberProjectPages(dao, projectId) {
  const remaining = dao.findRecordsByFilter("pages", `project = "${projectId}"`, "page_number,created", 100000, 0)
  let writes = 0
  remaining.forEach((page, index) => {
    const target = index + 1
    if (page.getInt("page_number") !== target) {
      page.set("page_number", target)
      dao.save(page)
      writes++
    }
  })
  return writes
}

module.exports = { renumberProjectPages }