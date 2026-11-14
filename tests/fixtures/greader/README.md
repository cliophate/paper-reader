# Source-derived reader fixtures

These fixtures are synthetic. They are not captured traffic and do not claim
tested app releases or operating systems. Source files were downloaded as data
and were not executed. Replay uses synthetic feed and article IDs.

The request builders and account services supply call order, repeated fields,
batch sizes, ID forms and headers. Independent DTO assertions check the required
JSON types. Capy content downloads run eight at once. Read You sends quickadd in
both query and body. NetNewsWire sends long IDs in 150-item content batches and
1,000-item state batches. The other sizes are recorded in clients.json.

## Sources

- [ReaderAPICaller.swift](https://github.com/Ranchero-Software/NetNewsWire/blob/7908c801bf7c97fa7cca9ef78cf51b33fb853e6a/Modules/Account/Sources/Account/ReaderAPI/ReaderAPICaller.swift), SHA-256 `e4fb1ff27dab008cf8a51a78ee05b1031849e0f8e51ef9209c136be357e3332a`.
- [URLRequest+ReaderAPI.swift](https://github.com/Ranchero-Software/NetNewsWire/blob/7908c801bf7c97fa7cca9ef78cf51b33fb853e6a/Modules/Account/Sources/Account/ReaderAPI/URLRequest%2BReaderAPI.swift), SHA-256 `551b686bfb8412bcacbc8da1d129430ae33e4e1d6b5525f5925bc6b8a586bd56`.
- [ReaderAPIAccountDelegate.swift](https://github.com/Ranchero-Software/NetNewsWire/blob/7908c801bf7c97fa7cca9ef78cf51b33fb853e6a/Modules/Account/Sources/Account/ReaderAPI/ReaderAPIAccountDelegate.swift), SHA-256 `aecd73cc37a807ba673d1281b799be52368afd8ff60d7600b19f154e34c7b61d`.
- [ReaderAPIEntry.swift](https://github.com/Ranchero-Software/NetNewsWire/blob/7908c801bf7c97fa7cca9ef78cf51b33fb853e6a/Modules/Account/Sources/Account/ReaderAPI/ReaderAPIEntry.swift), SHA-256 `7df9d9b491b842ea0bb803fe40fc2000c7e7bac2182ff4931973ae91db6c0f78`.
- [GoogleReaderAPI.kt](https://github.com/ReadYouApp/ReadYou/blob/d2b979ccad9a3e54b9499929a9dc2824578b0fd9/app/src/main/java/me/ash/reader/infrastructure/rss/provider/greader/GoogleReaderAPI.kt), SHA-256 `fb48cc8eb988ae55e45a4730ded949973bd084281bbe052232dd21b0d6526c21`.
- [GoogleReaderRssService.kt](https://github.com/ReadYouApp/ReadYou/blob/d2b979ccad9a3e54b9499929a9dc2824578b0fd9/app/src/main/java/me/ash/reader/domain/service/GoogleReaderRssService.kt), SHA-256 `ce24758a1b6f6b27132d8e9457dccc8ee766c00448d28529837d166a59f8f6d2`.
- [GoogleReaderDTO.kt](https://github.com/ReadYouApp/ReadYou/blob/d2b979ccad9a3e54b9499929a9dc2824578b0fd9/app/src/main/java/me/ash/reader/infrastructure/rss/provider/greader/GoogleReaderDTO.kt), SHA-256 `97513de8f3c284be6c9269c566218bf79a8e1fb832a6c7d706debe37e51bbb39`.
- [GoogleReader.kt](https://github.com/jocmp/capyreader/blob/39882fe5b9a1d62ceb588354dde3cfbeb903424b/readerclient/src/main/java/com/jocmp/readerclient/GoogleReader.kt), SHA-256 `1a37f08d7ae6c42e485029a35197117fc83863c5e79223696407404f2ee76a5f`.
- [GoogleReaderExt.kt](https://github.com/jocmp/capyreader/blob/39882fe5b9a1d62ceb588354dde3cfbeb903424b/readerclient/src/main/java/com/jocmp/readerclient/ext/GoogleReaderExt.kt), SHA-256 `0444f71db19d5043d1e7e86bce185bf9921e29a9e7ea948bc4a70b6001993b23`.
- [ReaderAccountDelegate.kt](https://github.com/jocmp/capyreader/blob/39882fe5b9a1d62ceb588354dde3cfbeb903424b/capy/src/main/java/com/jocmp/capy/accounts/reader/ReaderAccountDelegate.kt), SHA-256 `3095c02a177e01f68cec928163cdd8cefb3779b0dfa29d9bef93f6581acedff3`.
- [ReaderCredentials.kt](https://github.com/jocmp/capyreader/blob/39882fe5b9a1d62ceb588354dde3cfbeb903424b/capy/src/main/java/com/jocmp/capy/accounts/reader/ReaderCredentials.kt), SHA-256 `804e3aba61525212e884e8ee4106712865d9f2c814ce285461eca4287e296faa`.
- [FreshRSSPath.kt](https://github.com/jocmp/capyreader/blob/39882fe5b9a1d62ceb588354dde3cfbeb903424b/capy/src/main/java/com/jocmp/capy/accounts/FreshRSSPath.kt), SHA-256 `7cfccb80e2900ed64ab0a8309609d1509cc6c7562487ceb0ef9756236ff3f097`.
