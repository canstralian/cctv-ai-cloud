from fastapi import FastAPI
app = FastAPI(title="CCTV AI Cloud API")

@app.get("/health")
def health():
    return {"status": "ok"}
