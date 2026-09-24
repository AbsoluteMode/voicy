FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 voicy && mkdir /data && chown voicy /data
COPY --from=build /src/target/release/voicy-server /usr/local/bin/voicy-server
USER voicy
VOLUME /data
ENTRYPOINT ["voicy-server"]
